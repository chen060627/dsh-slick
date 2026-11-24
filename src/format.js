// dsh-slick — content decisions and a minimal, dependency-free XLSX writer.
//
// This file is pure: no DOM, no imports. `scripts/build.mjs` inlines it into
// client.js, and the tests import it directly under Node to verify the bytes
// with a real spreadsheet reader.
//
// Public surface (also assigned to globalThis.__dshSlickFormat):
//   detectTable(text)  -> string[][] | null   (≥2 rows and every row has ≥2 cells)
//   planFor(text)      -> { kind, name, mime, bytes } | null
//   buildXlsx(rows)    -> Uint8Array

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const encoder = new TextEncoder()

// ---- ZIP (store) -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff]
  return (c ^ 0xffffffff) >>> 0
}

function concat(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** DOS timestamp for the current local time. */
function dosStamp(now) {
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff
  return { time, date }
}

/**
 * A ZIP archive with every entry stored (no compression). Spreadsheet readers
 * accept stored entries; skipping DEFLATE keeps the writer synchronous and
 * available on the paste's critical path.
 */
function zipStore(entries, now = new Date()) {
  const { time, date } = dosStamp(now)
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = entry.data
    const crc = crc32(data)

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0x0800, true) // UTF-8 names
    lv.setUint16(8, 0, true) // store
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)

    localParts.push(local, data)
    centralParts.push(central)
    offset += local.length + data.length
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(4, 0, true)
  ev.setUint16(6, 0, true)
  ev.setUint16(8, centralParts.length, true)
  ev.setUint16(10, centralParts.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  return concat([...localParts, ...centralParts, eocd])
}

// ---- XLSX parts ------------------------------------------------------------

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // control characters are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function columnName(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Bare integer/decimal, no leading zeros (so "0012" and "1e5" stay text). */
function isNumericCell(value) {
  return /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/.test(value)
}

const MAX_CELL_CHARS = 32000

function sheetXml(rows) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
  ]
  rows.forEach((cells, r) => {
    parts.push(`<row r="${r + 1}">`)
    cells.forEach((raw, c) => {
      const value = String(raw == null ? '' : raw).trim()
      if (value === '') return
      const ref = columnName(c) + (r + 1)
      if (isNumericCell(value)) {
        parts.push(`<c r="${ref}"><v>${value}</v></c>`)
      } else {
        const text = value.length > MAX_CELL_CHARS ? value.slice(0, MAX_CELL_CHARS) : value
        parts.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`)
      }
    })
    parts.push('</row>')
  })
  parts.push('</sheetData></worksheet>')
  return parts.join('')
}

function contentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>'
}

function rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>'
}

function workbookXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
}

function workbookRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>'
}

/** Build a one-sheet workbook whose cells keep numbers numeric and text as text. */
function buildXlsx(rows, now = new Date()) {
  const entries = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypesXml()) },
    { name: '_rels/.rels', data: encoder.encode(rootRelsXml()) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbookXml()) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRelsXml()) },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(sheetXml(rows)) },
  ]
  return zipStore(entries, now)
}

// ---- decisions -------------------------------------------------------------

/** Trailing/leading blank lines dropped; interior blank rows count as empty rows. */
function tableRows(text) {
  const rows = String(text).replace(/\r\n?/g, '\n').split('\n')
  while (rows.length > 0 && rows[rows.length - 1].trim() === '') rows.pop()
  while (rows.length > 0 && rows[0].trim() === '') rows.shift()
  return rows
}

/**
 * A pasted table: at least two rows, and every row carries at least two
 * tab-separated cells. Returns trimmed cell values, or null.
 */
function detectTable(text) {
  const rows = tableRows(text)
  if (rows.length < 2) return null
  if (!rows.some((row) => row.includes('\t'))) return null
  const cells = rows.map((row) => row.split('\t').map((cell) => cell.trim()))
  if (cells.some((row) => row.length < 2)) return null
  if (!cells.some((row) => row.some((cell) => cell !== ''))) return null
  return cells
}

function two(value) {
  return String(value).padStart(2, '0')
}

function stamp(prefix, extension, now = new Date()) {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  return `${prefix}-${day}-${time}.${extension}`
}

/**
 * Decide what a paste becomes. Tables win over length: a 3×3 number grid is
 * only ~30 characters but still belongs in a workbook.
 */
function planFor(text, now = new Date()) {
  const value = String(text == null ? '' : text)
  const rows = detectTable(value)
  if (rows) {
    return {
      kind: 'xlsx',
      name: stamp('表格', 'xlsx', now),
      mime: XLSX_MIME,
      bytes: buildXlsx(rows, now),
    }
  }
  if (value.length > 500) {
    return {
      kind: 'txt',
      name: stamp('长文本', 'txt', now),
      mime: 'text/plain',
      bytes: encoder.encode(value),
    }
  }
  return null
}

const api = { XLSX_MIME, detectTable, planFor, buildXlsx, stamp, buildXlsxForTest: buildXlsx }
globalThis.__composerToolsFormat = api