import path from "node:path"
import { mkdir } from "node:fs/promises"
import { writeFileSync, existsSync } from "node:fs"
import type { LLMTool, LLMToolCall } from "../providers/types.ts"
import type { ToolResult } from "./agent-loop.ts"
import { spawnSync } from "node:child_process"

/**
 * Resolve shell prefix args for command execution on the current platform.
 * On Windows, prefers native Git Bash (not WSL bash which runs in a Linux VM).
 * Skips WSL bash (`C:\Windows\System32\bash.exe` — runs in isolated Linux env).
 * Falls back to PowerShell.
 */
export function resolveShellPrefix(): string[] {
  if (process.platform !== "win32") return ["sh", "-c"]
  // Try common Git Bash install locations
  const searchDirs: string[] = []
  for (const drive of ["C:", "D:", "E:"]) {
    for (const sub of ["Git", "MyApplications\\Git", "Program Files\\Git", "Program Files (x86)\\Git"]) {
      searchDirs.push(`${drive}\\${sub}\\bin\\bash.exe`)
    }
  }
  for (const candidate of searchDirs) {
    try {
      const r = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 3000 })
      if (r.status === 0) return [candidate, "-c"]
    } catch { /* not found */ }
  }
  // Try bash on PATH (exclude WSL in System32 and WindowsApps stubs)
  try {
    const r = spawnSync("where", ["bash"], { encoding: "utf8", timeout: 3000 })
    if (r.status === 0) {
      const lines = r.stdout.trim().split(/\r?\n/)
      const nativeBash = lines.find((l) =>
        !l.toLowerCase().includes("\\system32\\") &&
        !l.toLowerCase().includes("\\windowsapps\\")
      )
      if (nativeBash) return [nativeBash, "-c"]
    }
  } catch { /* not found */ }
  return ["powershell", "-NoProfile", "-Command"]
}

/**
 * Rewrite bash heredoc syntax into a temp-file form that PowerShell / cmd can run.
 * E.g. `python3 << 'EOF'\n...\nEOF` → `python3 C:\Temp\...\_skvm_heredoc.py`
 */
export function rewriteHeredoc(orig: string, workDir: string): string {
  const heredocMatch = orig.match(/^(.+?)\s+<<\s*(['"]?)(\w+)\2\s*([\s\S]*)$/)
  if (!heredocMatch) return orig
  const [, preamble, , delimiter = "EOF", body = ""] = heredocMatch
  const endMarker = new RegExp(`^${delimiter}$`, "m")
  const endIdx = body.search(endMarker)
  if (endIdx === -1) return orig
  const heredocContent = body.slice(0, endIdx).trim()
  const remainder = body.slice(endIdx + delimiter.length).trim()
  const tmpFile = path.join(workDir, `_skvm_heredoc_${Date.now()}.tmp`)
  writeFileSync(tmpFile, heredocContent)
  const rewritten = `${preamble} ${tmpFile}${remainder ? ` ; ${remainder}` : ""}`
  return rewritten
}

/**
 * On Windows, the first word of a command (e.g. `python3`) may resolve to a
 * fake 0-byte Windows App Execution Alias stub. Replace with the real binary
 * if available. Fallbacks: python3→python→py, node→node (unchanged).
 */
export function resolveRealExe(argv0: string): string {
  if (process.platform !== "win32") return argv0
  // Check if the executable actually exists and is non-zero
  const resolved = resolveExePath(argv0)
  if (resolved) {
    try {
      const r = spawnSync(resolved, ["--version"], { encoding: "utf8", timeout: 5000 })
      if (r.status === 0) return argv0 // real executable works
    } catch { /* fall through */ }
  }
  // Try fallback aliases
  const fallbacks: Record<string, string[]> = {
    "python3": ["python", "py"],
    "python": ["python3", "py"],
  }
  for (const alt of fallbacks[argv0] ?? []) {
    const altResolved = resolveExePath(alt)
    if (altResolved) {
      try {
        const r = spawnSync(altResolved, ["--version"], { encoding: "utf8", timeout: 5000 })
        if (r.status === 0) return alt
      } catch { /* try next */ }
    }
  }
  return argv0 // no fallback found, let it fail with original error
}

/** Find an executable on PATH (Windows-aware). Skips WSL and fake stubs. */
function resolveExePath(name: string): string | null {
  try {
    const r = spawnSync("where", [name], { encoding: "utf8", timeout: 3000 })
    if (r.status === 0) {
      const lines = r.stdout.trim().split(/\r?\n/)
      for (const line of lines) {
        const p = line.trim()
        if (!p) continue
        const lp = p.toLowerCase()
        if (lp.includes("\\windowsapps\\") || lp.includes("\\system32\\")) continue
        if (existsSync(p)) return p
      }
    }
  } catch { /* not found */ }
  return null
}

// ---------------------------------------------------------------------------
// Shared Tool Definitions
// ---------------------------------------------------------------------------

export const AGENT_TOOLS: LLMTool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file at the given path relative to the working directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Relative file path" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file at the given path relative to the working directory. Creates directories as needed. You MUST read_file first before writing (unless creating a new file).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "execute_command",
    description: "Execute a shell command in the working directory. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "Shell command to execute" } },
      required: ["command"],
    },
  },
]

// ---------------------------------------------------------------------------
// Shared Tool Executor
// ---------------------------------------------------------------------------

export interface AgentToolExecutorOptions {
  /** Require read_file before write_file for existing files */
  requireReadBeforeWrite?: boolean
}

export function createAgentToolExecutor(
  workDir: string,
  opts?: AgentToolExecutorOptions,
): (call: LLMToolCall) => Promise<ToolResult> {
  const readPaths = new Set<string>()

  return async (call: LLMToolCall): Promise<ToolResult> => {
    const start = performance.now()
    const args = call.arguments

    try {
      switch (call.name) {
        case "read_file": {
          const filePath = path.resolve(workDir, args.path as string)
          const file = Bun.file(filePath)
          if (!(await file.exists())) {
            return { output: `Error: File not found: ${args.path}`, durationMs: performance.now() - start }
          }
          if (opts?.requireReadBeforeWrite) {
            readPaths.add(filePath)
          }
          return { output: await file.text(), durationMs: performance.now() - start }
        }

        case "write_file": {
          const filePath = path.resolve(workDir, args.path as string)
          if (opts?.requireReadBeforeWrite) {
            const exists = await Bun.file(filePath).exists()
            if (exists && !readPaths.has(filePath)) {
              return {
                output: `Error: You must read_file('${args.path}') before writing to it. This ensures you're editing from the current content, not generating from scratch.`,
                durationMs: performance.now() - start,
              }
            }
          }
          await mkdir(path.dirname(filePath), { recursive: true })
          await Bun.write(filePath, args.content as string)
          return { output: `File written: ${args.path}`, durationMs: performance.now() - start }
        }

        case "execute_command": {
          let cmd = args.command as string
          // Block commands that could kill the parent process (e.g. agent running `pkill bun`)
          if (/\b(pkill|killall)\b/.test(cmd)) {
            return {
              output: "Error: pkill/killall are not allowed. Use `kill <PID>` to stop a specific process.",
              durationMs: performance.now() - start,
            }
          }
          const shellPrefix = resolveShellPrefix()
          // On Windows PowerShell, rewrite bash heredocs to temp-file form
          if (process.platform === "win32" && shellPrefix[0] === "powershell" && cmd.includes("<<")) {
            cmd = rewriteHeredoc(cmd, workDir)
          }
          // On Windows, replace fake WindowsApps stubs (python3, bash, etc.) with real binaries
          if (process.platform === "win32") {
            const argv0Match = cmd.match(/^(\S+)/)
            if (argv0Match?.[1]) {
              const argv0 = argv0Match[1]
              const real = resolveRealExe(argv0)
              if (real !== argv0) cmd = real + cmd.slice(argv0.length)
            }
          }
          const TOOL_TIMEOUT_MS = 30_000
          const READ_TIMEOUT_MS = 2_000
          const proc = Bun.spawn([...shellPrefix, cmd], {
            cwd: workDir,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, HOME: process.env.USERPROFILE ?? process.env.HOME },
          })
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("command timed out after 30s")), TOOL_TIMEOUT_MS),
          )
          try {
            const exitCode = await Promise.race([proc.exited, timeout])
            const readWithTimeout = <T>(p: Promise<T>, fallback: T): Promise<T> =>
              Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), READ_TIMEOUT_MS))])
            const stdout = await readWithTimeout(new Response(proc.stdout).text(), "")
            const stderr = await readWithTimeout(new Response(proc.stderr).text(), "")
            const output = [
              stdout ? `stdout:\n${stdout}` : "",
              stderr ? `stderr:\n${stderr}` : "",
              `exit code: ${exitCode}`,
            ].filter(Boolean).join("\n")
            return { output, exitCode, durationMs: performance.now() - start }
          } catch {
            proc.kill()
            return { output: "Error: command timed out after 30s", durationMs: performance.now() - start }
          }
        }

        default:
          return { output: `Unknown tool: ${call.name}`, durationMs: performance.now() - start }
      }
    } catch (err) {
      return { output: `Error: ${err}`, durationMs: performance.now() - start }
    }
  }
}
