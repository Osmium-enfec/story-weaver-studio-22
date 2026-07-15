export const OPENAI_API = "https://api.openai.com/v1";

export function requireOpenAIKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY not configured");
  return key;
}

export function openAIHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireOpenAIKey()}`,
    "Content-Type": "application/json",
  };
}
