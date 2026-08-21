/**
 * Lightweight Python-oriented formatting for code-typing templates.
 * Normalizes whitespace (not a full Black/ruff pass).
 */
export function formatPythonCode(source: string): string {
  let text = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\t/g, "    ");

  const rawLines = text.split("\n");
  const out: string[] = [];
  let prevBlank = false;

  for (const raw of rawLines) {
    const line = raw.replace(/[ \t]+$/g, "");
    const isBlank = line.trim().length === 0;
    if (isBlank) {
      if (!prevBlank && out.length > 0) out.push("");
      prevBlank = true;
      continue;
    }
    prevBlank = false;
    out.push(line);
  }

  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.length ? `${out.join("\n")}\n` : "";
}

export const DEFAULT_CODE_TYPING_SNIPPET = `def greet(name: str) -> str:
    return f"Hello, {name}!"


user = {"name": "Daniel", "age": 25, "country": "India"}
print(greet(user["name"]))
`;

/** Default console output for the sample snippet (user-editable). */
export const DEFAULT_CODE_TYPING_OUTPUT = `Hello, Daniel!
`;

/** Optional second-step append for multi-run demos. */
export const DEFAULT_CODE_TYPING_SNIPPET_STEP2 = `
print("Ready to ship!")
`;

export const DEFAULT_CODE_TYPING_OUTPUT_STEP2 = `Hello, Daniel!
Ready to ship!
`;
