/**
 * Host half of the bundle.
 *
 * The browser half owns paste conversion, image annotation, the model-menu teamwork
 * lightning, and the Settings page. This half adds one system-prompt section that turns
 * Agent Teams from "available" into a requirement whenever its task-board tools are
 * actually mounted in the session.
 *
 * The text is self-gating on purpose: the team tools exist only while the root Session
 * enables Team mode, so a session with Team off simply never sees those tool names and
 * the instruction tells the model to ignore it.
 *
 * This half also serves `/dsh-slick/restart`, so the browser half can restart the
 * desktop app: close it, wait three seconds, and start it again.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Exact HTTP path of the restart endpoint. */
const RESTART_PATH = '/dsh-slick/restart'

/** Exact HTTP path the browser calls to remove the native window menu bar. */
const HIDE_MENU_PATH = '/dsh-slick/hide-menu'

/** Exact HTTP path the client posts diagnostics to during development. */
const DEBUG_LOG_PATH = '/dsh-slick/debug-log'

/** File the diagnostics are appended to. */
const DEBUG_LOG_FILE = path.join(process.env.TEMP ?? '.', 'dsh-slick-debug.log')

/** Peer addresses the restart endpoint accepts: loopback spellings only. */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Milliseconds the helper waits before touching the app, so the 202 reaches the browser. */
const RESTART_ARM_DELAY_MS = 250

/** Seconds the helper waits after closing the app before starting it again. */
const RESTART_RELAUNCH_DELAY_SECONDS = 0

/**
 * Apply the host half: the team-policy prompt section and the restart endpoint.
 *
 * @param {object} ctx Cordis plugin context.
 */
export function apply(ctx) {
  // One prompt section for everything this package contributes, so the transcript shows a single
  // "context injection" entry instead of several.
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.systemPrompt.section({
      name: 'dsh-slick:policy',
      // Right after the shipped Team policy (600), before the PTC/tool guidance.
      order: 610,
      /** @returns {string} the team policy plus the current subagent requirement. */
      text: () => {
        const parts = [
          'Agent Teams is MANDATORY in this session whenever the shared task-board tools',
          '(team_task_create, team_task_list, team_task_get, team_task_update) are available.',
          'Before delegating any work, create one shared task per unit of work, recording its',
          'expected write scope and dependencies. Every teammate MUST claim a ready task with',
          'its current revision, do exactly that task, and complete it. Never delegate or',
          'perform multi-agent work outside the board, and never duplicate a task another',
          'member already owns. The Lead keeps the board current and waits for required',
          'teammates before the final answer. If those tools are not available, ignore this',
          'instruction.',
        ]
        if (requirement.count > 0) {
          parts.push(
            `This session is configured to run ${requirement.count} subagents in parallel.`,
            `Spawn exactly ${requirement.count} subagents for the work of this turn, concurrently,`,
            'and let them do the work; do not finish the task alone in the main agent.',
          )
        }
        return parts.join(' ')
      },
    })
  })

  registerRestartRoute(ctx)
  registerSubagentRequirement(ctx)
  registerHideMenuRoute(ctx)
  registerDebugLogRoute(ctx)
}

/** Exact HTTP path the browser posts the subagent requirement to. */
const REQUIREMENT_PATH = '/dsh-slick/subagent-requirement'

/**
 * How many subagents the browser wants this turn to run. Zero means "no requirement". Kept in
 * module scope so the prompt section can read it without re-registering.
 *
 * @type {{ count: number }}
 */
const requirement = { count: 0 }

/**
 * Serve the requirement endpoint. The prompt text itself is emitted by the single
 * `dsh-slick:policy` section (see apply), which reads `requirement.count` at assembly time.
 *
 * @param {object} ctx Cordis plugin context.
 */
function registerSubagentRequirement(ctx) {
  const webServer = getWebServer(ctx)
  const attach = (server) => {
    ctx.effect(() => {
      const dispose = server.register({
        kind: 'exact',
        path: REQUIREMENT_PATH,
        handler: (req, res) => {
          handleRequirementRequest(ctx, req, res)
        },
      })
      return () => {
        try {
          dispose()
        } catch (error) {
          warn(ctx, 'dsh-slick: requirement endpoint cleanup failed', error)
        }
      }
    })
  }
  if (webServer) {
    attach(webServer)
    return
  }
  try {
    ctx.inject(['webServer'], (scoped) => {
      attach(scoped.webServer)
    })
  } catch (error) {
    warn(ctx, 'dsh-slick: webServer unavailable; subagent requirement endpoint disabled', error)
  }
}

/**
 * Accept one requirement update from the browser.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @param {import('node:http').ServerResponse} res Response to answer on.
 */
function handleRequirementRequest(ctx, req, res) {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'POST' })
    return
  }
  const chunks = []
  req.on('data', (chunk) => {
    chunks.push(chunk)
    // Refuse oversized bodies instead of buffering without bound.
    if (chunks.reduce((size, part) => size + part.length, 0) > 4096) {
      chunks.length = 0
      req.destroy()
      sendJson(res, 413, { ok: false, error: 'body too large' })
    }
  })
  req.on('end', () => {
    let parsed = null
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
      warn(ctx, 'dsh-slick: requirement payload is not JSON', error)
      sendJson(res, 400, { ok: false, error: 'invalid json' })
      return
    }
    const raw = Number(parsed?.count)
    const count = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
    requirement.count = count
    sendJson(res, 200, { ok: true, count })
  })
  req.on('error', (error) => {
    warn(ctx, 'dsh-slick: requirement request failed', error)
    sendJson(res, 500, { ok: false, error: 'request failed' })
  })
}

/**
 * Report a contained failure through the host logger when it provides one. Logging is the
 * last line of defence on every failure path, so it must never throw itself.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {string} message Human-readable summary.
 * @param {unknown} [error] The underlying failure, when there is one.
 */
function warn(ctx, message, error) {
  try {
    const detail = error instanceof Error ? error.message : error === undefined ? '' : String(error)
    ctx.logger?.warn?.(detail ? `${message}: ${detail}` : message)
  } catch {
    // Nothing useful is left to do when the logger itself fails.
  }
}

/**
 * Attach the restart endpoint to the web server service. A host without a web server, for
 * example a headless session, keeps the system-prompt section and logs why the endpoint is
 * unavailable instead of failing activation.
 *
 * @param {object} ctx Cordis plugin context.
 */
function registerRestartRoute(ctx) {
  const webServer = getWebServer(ctx)
  if (webServer) {
    attachRestartRoute(ctx, webServer)
    return
  }
  // The service can still be loading while this plugin applies; wait for it rather than
  // disabling the endpoint for the rest of the session.
  try {
    ctx.inject(['webServer'], (scoped) => {
      attachRestartRoute(scoped, scoped.webServer)
    })
  } catch (error) {
    warn(ctx, 'dsh-slick: webServer service unavailable; restart endpoint disabled', error)
  }
}

/**
 * Read the web server service from the context, treating a missing service as absent
 * instead of letting a lookup failure escape.
 *
 * @param {object} ctx Cordis plugin context.
 * @returns {object | undefined} The web server service, when it exposes `register`.
 */
function getWebServer(ctx) {
  try {
    const webServer = ctx.get('webServer')
    return typeof webServer?.register === 'function' ? webServer : undefined
  } catch (error) {
    warn(ctx, 'dsh-slick: webServer lookup failed', error)
    return undefined
  }
}

/**
 * Register the diagnostics sink used while debugging the model-menu slider.
 * @param {object} ctx Cordis plugin context.
 */
function registerDebugLogRoute(ctx) {
  const webServer = getWebServer(ctx)
  if (!webServer) return
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'exact',
      path: DEBUG_LOG_PATH,
      handler: (req, res) => {
        if (!isLoopbackRequest(req)) { sendJson(res, 403, { ok: false }); return }
        let body = ''
        req.setEncoding('utf8')
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          try {
            fs.appendFileSync(DEBUG_LOG_FILE, body + '\n', 'utf8')
          } catch (error) {
            warn(ctx, 'dsh-slick: debug log write failed', error)
          }
          sendJson(res, 200, { ok: true })
        })
      },
    })
    return () => { try { dispose() } catch { /* ignore */ } }
  })
}

/**
 * Register the route that removes the native Electron menu bar ("应用 / 编辑"). A plugin cannot
 * touch Electron's Menu API from this host process, so the window's menu is stripped with the
 * Win32 SetMenu call instead — the same "spawn a helper process" technique the restart uses.
 *
 * @param {object} ctx Cordis plugin context.
 */
function registerHideMenuRoute(ctx) {
  const webServer = getWebServer(ctx)
  const attach = (server) => {
    ctx.effect(() => {
      const dispose = server.register({
        kind: 'exact',
        path: HIDE_MENU_PATH,
        handler: (req, res) => {
          try {
            handleHideMenuRequest(ctx, req, res)
          } catch (error) {
            warn(ctx, 'dsh-slick: hide-menu request failed', error)
            sendJson(res, 500, { ok: false, error: 'hide-menu failed' })
          }
        },
      })
      return () => {
        try {
          dispose()
        } catch (error) {
          warn(ctx, 'dsh-slick: hide-menu endpoint cleanup failed', error)
        }
      }
    })
  }
  if (webServer) {
    attach(webServer)
    return
  }
  try {
    ctx.inject(['webServer'], (scoped) => attach(scoped.webServer))
  } catch (error) {
    warn(ctx, 'dsh-slick: hide-menu endpoint disabled', error)
  }
}

/**
 * @param {object} ctx Cordis plugin context.
 * @param {import('node:http').IncomingMessage} req The request.
 * @param {import('node:http').ServerResponse} res The response.
 */
function handleHideMenuRequest(ctx, req, res) {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  const hidden = stripNativeMenu(ctx)
  sendJson(res, 200, { ok: true, hidden })
}

/**
 * Call Win32 SetMenu(window, NULL) on the desktop window, which removes its menu bar.
 *
 * @param {object} ctx Cordis plugin context.
 * @returns {boolean} whether a window was found and had its menu cleared.
 */
function stripNativeMenu(ctx) {
  if (process.platform !== 'win32') return false
  const pid = resolveRestartTargetPid()
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DshMenu {',
    '  [DllImport("user32.dll")] public static extern IntPtr SetMenu(IntPtr hWnd, IntPtr hMenu);',
    '  [DllImport("user32.dll")] public static extern bool DrawMenuBar(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '}',
    '"@',
    '$h = [IntPtr]::Zero',
    'for ($i = 0; $i -lt 20 -and $h -eq [IntPtr]::Zero; $i++) {',
    '  $p = Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue',
    '  if ($p -ne $null) { $h = $p.MainWindowHandle }',
    '  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 400 }',
    '}',
    'if ($h -ne [IntPtr]::Zero) {',
    '  [void][DshMenu]::SetMenu($h, [IntPtr]::Zero)',
    '  [void][DshMenu]::DrawMenuBar($h)',
    '  Write-Output "hidden"',
    '}',
  ].join('\n')
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script,
    ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    if (result.error !== undefined) {
      warn(ctx, 'dsh-slick: menu strip could not run', result.error)
      return false
    }
    return typeof result.stdout === 'string' && result.stdout.includes('hidden')
  } catch (error) {
    warn(ctx, 'dsh-slick: menu strip threw', error)
    return false
  }
}

/**
 * Register the exact restart route and hand its disposal to `ctx.effect`, so unloading the
 * plugin removes the route again.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {object} webServer The host web server service.
 */
function attachRestartRoute(ctx, webServer) {
  try {
    ctx.effect(() => {
      const dispose = webServer.register({
        kind: 'exact',
        path: RESTART_PATH,
        handler: createRestartHandler(ctx),
      })
      return () => {
        try {
          dispose()
        } catch (error) {
          warn(ctx, 'dsh-slick: restart endpoint cleanup failed', error)
        }
      }
    })
  } catch (error) {
    warn(ctx, 'dsh-slick: could not register the restart endpoint', error)
  }
}

/**
 * Create the HTTP handler for the restart endpoint, bound to one plugin context.
 *
 * @param {object} ctx Cordis plugin context.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} The route handler.
 */
function createRestartHandler(ctx) {
  return (req, res) => {
    try {
      handleRestartRequest(ctx, req, res)
    } catch (error) {
      warn(ctx, 'dsh-slick: restart request failed', error)
      sendJson(res, 500, { ok: false, error: 'restart request failed' })
    }
  }
}

/**
 * Answer one restart request: probe on GET, restart on POST, refuse anything else. The
 * restart is armed only after the 202 is committed, and the helper it starts waits before
 * closing anything, so the browser always receives its answer first.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {import('node:http').IncomingMessage} req The incoming request.
 * @param {import('node:http').ServerResponse} res The response to answer on.
 */
function handleRestartRequest(ctx, req, res) {
  if (!isLoopbackRequest(req)) {
    sendJson(res, 403, { ok: false, error: 'loopback only' })
    return
  }
  const capability = restartCapability()
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, armed: capability.ok, reason: capability.reason ?? null })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' }, { allow: 'GET, POST' })
    return
  }
  if (!capability.ok) {
    // Refuse loudly: killing the wrong process here costs the user their whole session.
    sendJson(res, 501, { ok: false, error: 'restart unsupported', reason: capability.reason ?? null })
    return
  }
  let helper
  try {
    helper = buildRestartCommand(resolveRestartTargetPid(), resolveRestartExecutable())
  } catch (error) {
    warn(ctx, 'dsh-slick: could not prepare the restart', error)
    sendJson(res, 500, { ok: false, error: 'restart unavailable' })
    return
  }
  // Answer first: nothing destructive may run before the 202 reaches the browser.
  res.once('finish', () => {
    try {
      spawnRestartHelper(ctx, helper)
    } catch (error) {
      warn(ctx, 'dsh-slick: could not start the restart helper', error)
    }
  })
  sendJson(res, 202, { ok: true })
}

/**
 * Decide whether a request arrived over the loopback interface. Only the loopback
 * spellings Node reports for a local socket are accepted.
 *
 * @param {import('node:http').IncomingMessage} req The incoming request.
 * @returns {boolean} True when the peer is this machine.
 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address)
}

/**
 * Write a JSON response exactly once. A committed response or a dead socket is left alone,
 * so a late failure can never throw through the HTTP stack.
 *
 * @param {import('node:http').ServerResponse} res The response to answer on.
 * @param {number} status HTTP status code.
 * @param {Record<string, unknown>} body JSON-serializable payload.
 * @param {Record<string, string>} [headers] Extra response headers.
 */
function sendJson(res, status, body, headers = {}) {
  try {
    if (res.headersSent || res.writableEnded) return
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    })
    res.end(JSON.stringify(body))
  } catch {
    // The client is gone; there is no one left to report to.
    try {
      res.destroy()
    } catch {
      // The socket is already unusable.
    }
  }
}

/**
 * Decide whether this host may restart the app at all.
 *
 * Only the Windows desktop build has a proven relaunch path. Everywhere else the "parent
 * process" is not reliably the app — on Linux it can be the login shell or `systemd --user`,
 * and terminating that takes the whole session down (browser, remote desktop, other apps).
 * So the feature is refused outright instead of guessing.
 *
 * @returns {{ ok: boolean, reason?: string }} whether a restart is safe here.
 */
function restartCapability() {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'auto-restart is only supported on Windows; please restart DSH manually' }
  }
  if (process.versions === undefined || process.versions.electron === undefined) {
    return { ok: false, reason: 'auto-restart needs the desktop app; please restart DSH manually' }
  }
  const target = resolveRestartTargetPid()
  if (!Number.isInteger(target) || target <= 1 || target === process.pid) {
    return { ok: false, reason: 'could not identify the app process; please restart DSH manually' }
  }
  return { ok: true }
}

/**
 * Choose the process to close: the Electron main process that owns this host process,
 * falling back to this process when the parent id is not usable.
 *
 * @returns {number} A positive process id.
 */
function resolveRestartTargetPid() {
  return Number.isInteger(process.ppid) && process.ppid > 0 ? process.ppid : process.pid
}

/**
 * Resolve the executable to start after the restart. The desktop host runs as
 * `DeepSeek Harness.exe --expose-internals ...`, so `process.execPath` is the app itself;
 * the well-known install path covers a moved or unavailable executable.
 *
 * @returns {string} Path of the executable to relaunch.
 */
function resolveRestartExecutable() {
  const execPath = process.execPath
  if (execPath && existsOnDisk(execPath)) return execPath
  if (process.platform !== 'win32') return execPath
  return path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
}

/**
 * Windows restart strategy: a one-shot Scheduled Task running as the signed-in user (/IT), which
 * puts the helper in its own process tree *and* in the interactive session — a WMI-created or
 * detached child either dies with the app's tree or lands in session 0 where it cannot start a GUI.
 *
 * The helper is a .vbs run by wscript.exe: unlike a .cmd, it never allocates a console window, so
 * the user sees no black window flash.
 *
 * @param {number} targetPid Process id of the desktop app main process.
 * @param {string} executable Path of the executable to relaunch.
 * @returns {{ command: string, args: string[] }} The helper invocation.
 */
function buildWindowsRestartCommand(targetPid, executable) {
  const dir = path.join(process.env.TEMP ?? process.env.LOCALAPPDATA ?? '.', 'dsh-slick-restart')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    warn({}, 'dsh-slick: could not prepare the restart directory', error)
  }
  const stamp = `${String(Date.now())}-${String(process.pid)}`
  const helperFile = path.join(dir, `restart-${stamp}.vbs`)
  const taskName = `DSH-Restart-${stamp}`
  /** @param {string} value - raw text. @returns {string} text safe inside a VBScript string. */
  const ns = (value) => String(value).replace(/"/g, '""')
  // VBScript: no console window; waits, kills the app tree, waits, relaunches, then cleans up.
  const lines = [
    'Set shell = CreateObject("WScript.Shell")',
    `WScript.Sleep ${String(RESTART_ARM_DELAY_MS)}`,
    `shell.Run "taskkill /PID ${String(targetPid)} /T /F", 0, True`,
    `WScript.Sleep ${String(RESTART_RELAUNCH_DELAY_SECONDS * 1000)}`,
    `shell.Run """${ns(executable)}""", 1, False`,
    `shell.Run "schtasks /delete /tn ""${taskName}"" /f", 0, False`,
    `shell.Run "cmd /c del /f /q ""${ns(helperFile)}""", 0, False`,
  ]
  try {
    fs.writeFileSync(helperFile, `${lines.join('\r\n')}\r\n`, 'ascii')
  } catch (error) {
    warn({}, 'dsh-slick: could not write the restart helper', error)
  }
  // Create + run, then answer: the task itself handles the delay. Statements are joined with a
  // semicolon (in PowerShell `&` is the call operator, not a separator). The task runs the .vbs
  // directly — `.vbs` is associated with wscript.exe, which never opens a console window.
  const taskArg = `/TN '${escapePowerShellLiteral(taskName)}'`
  const taskRun = `/TR '"${escapePowerShellLiteral(helperFile)}"'`
  const script = [
    `$null = schtasks.exe /Create ${taskArg} /SC ONCE /ST 23:59 /RU $env:USERNAME /IT /F ${taskRun};`,
    `$null = schtasks.exe /Run ${taskArg};`,
  ].join(' ')
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
  }
}

/**
 * Build the detached helper invocation that performs the restart. The helper waits before
 * touching the app so the response is delivered, closes the app's process tree, waits, and
 * starts the executable again.
 *
 * @param {number} targetPid Process id of the desktop app main process.
 * @param {string} executable Path of the executable to relaunch.
 * @returns {{ command: string, args: string[] }} The helper invocation.
 */
function buildRestartCommand(targetPid, executable) {
  // Windows-only on purpose. There used to be a POSIX branch that ran
  // `kill -TERM <ppid>`: on Linux the host's parent can be the login shell or `systemd --user`,
  // so that killed the user's whole session instead of restarting DSH. Never bring it back.
  if (process.platform !== 'win32') {
    throw new Error('auto-restart is only supported on Windows')
  }
  return buildWindowsRestartCommand(targetPid, executable)
}

/**
 * Run the restart launcher and hand the actual work to the Scheduled Task.
 *
 * Synchronous on purpose: the launcher only creates and starts the task (well under a second), and
 * a *detached* child of this process is killed together with the app's job object, so the task
 * must be registered before the caller returns. The task itself is what waits and relaunches, so
 * blocking here for a moment costs nothing the user can perceive.
 *
 * @param {object} ctx Cordis plugin context.
 * @param {{ command: string, args: string[] }} helper The helper invocation to run.
 */
function spawnRestartHelper(ctx, helper) {
  try {
    const result = spawnSync(helper.command, helper.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    })
    if (result.error !== undefined) {
      warn(ctx, 'dsh-slick: restart launcher failed', result.error)
      return
    }
    if (result.status !== 0) {
      warn(ctx, `dsh-slick: restart launcher exited with ${String(result.status)}`, result.stderr)
    }
  } catch (error) {
    warn(ctx, 'dsh-slick: restart launcher threw', error)
  }
}

/**
 * Escape a value for a PowerShell single-quoted literal by doubling apostrophes.
 *
 * @param {string} value Raw value.
 * @returns {string} The value, safe between single quotes.
 */
function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''")
}

/**
 * Test whether a path exists without letting a filesystem error escape.
 *
 * @param {string} candidate Path to test.
 * @returns {boolean} True when the path exists.
 */
function existsOnDisk(candidate) {
  try {
    return fs.existsSync(candidate)
  } catch {
    return false
  }
}
