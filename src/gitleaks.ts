export type Finding = {
  rule: string
  match: string
}

export async function checkBinary(binary = "gitleaks"): Promise<boolean> {
  try {
    const proc = Bun.spawn([binary, "version"], { stdout: "ignore", stderr: "ignore" })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

// Findings are spliced out via `match` (not line/col) because multi-line
// matches have imprecise end columns in gitleaks' report.
export async function scanText(text: string, binary = "gitleaks"): Promise<Finding[]> {
  const args = [binary, "stdin", "--no-banner", "-l", "fatal", "-f", "json", "-r", "-"]
  const proc = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "ignore" })
  proc.stdin.write(text)
  proc.stdin.end()
  const code = await proc.exited
  if (code !== 0 && code !== 1) throw new Error(`gitleaks exited with code ${code}`)
  const out = (await new Response(proc.stdout).text()).trim()
  const found = (JSON.parse(out || "[]")) as Array<{ RuleID: string; Match: string }>
  return found.map((f) => ({ rule: f.RuleID, match: f.Match }))
}

export function redactText(text: string, findings: Finding[]): string {
  let out = text
  for (const f of findings) {
    out = out.split(f.match).join(`[REDACTED:${f.rule}]`)
  }
  return out
}
