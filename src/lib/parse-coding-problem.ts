/** Paste template for coding-problem scenes. Users replace the sample content. */
export const CODING_PROBLEM_TEMPLATE = `Title: 1. Two Sum

Instruction:
Given an array of integers nums and an integer target, return indices of the two numbers such that they add up to target.
You may assume that each input would have exactly one solution, and you may not use the same element twice.
You can return the answer in any order.

Starter Code:
class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        
    }
};

Test Case 1:
Input: nums = [2,7,11,15], target = 9
Output: [0,1]

Test Case 2:
Input: nums = [3,2,4], target = 6
Output: [1,2]

Test Case 3:
Input: nums = [3,3], target = 6
Output: [0,1]
`;

export interface ParsedCodingProblem {
  title: string;
  instruction: string;
  starterCode: string;
  testCases: { label: string; input: string; output: string }[];
}

function sectionBody(text: string, startRe: RegExp, endRes: RegExp[]): string {
  const start = text.match(startRe);
  if (!start || start.index === undefined) return "";
  const from = start.index + start[0].length;
  let end = text.length;
  for (const re of endRes) {
    re.lastIndex = 0;
    const m = re.exec(text.slice(from));
    if (m && m.index !== undefined) {
      end = Math.min(end, from + m.index);
    }
  }
  return text.slice(from, end).trim();
}

/** Parse a coding-problem paste block into structured fields. */
export function parseCodingProblemText(raw: string): ParsedCodingProblem | null {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length < 20) return null;

  const titleMatch = text.match(/^\s*Title\s*:\s*(.+)$/im);
  const title = (titleMatch?.[1] ?? "").trim();

  const instruction = sectionBody(
    text,
    /^\s*Instruction\s*:\s*/im,
    [/^\s*Starter\s*Code\s*:/im, /^\s*Test\s*Case\s*\d+\s*:/im],
  );

  const starterCode = sectionBody(
    text,
    /^\s*Starter\s*Code\s*:\s*/im,
    [/^\s*Test\s*Case\s*\d+\s*:/im],
  );

  const testCases: { label: string; input: string; output: string }[] = [];
  const caseRe = /^\s*Test\s*Case\s*(\d+)\s*:\s*$/gim;
  const starts: { n: number; index: number; headerLen: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRe.exec(text)) !== null) {
    starts.push({
      n: Number(m[1]),
      index: m.index,
      headerLen: m[0].length,
    });
  }

  for (let i = 0; i < Math.min(3, starts.length); i++) {
    const cur = starts[i];
    const next = starts[i + 1];
    const block = text
      .slice(cur.index + cur.headerLen, next ? next.index : text.length)
      .trim();

    const inputMatch = block.match(
      /^\s*Input\s*:\s*([\s\S]*?)(?=^\s*Output\s*:|$)/im,
    );
    const outputMatch = block.match(/^\s*Output\s*:\s*([\s\S]*?)$/im);

    const input = (inputMatch?.[1] ?? "").trim();
    const output = (outputMatch?.[1] ?? "").trim();
    if (!input && !output) continue;

    testCases.push({
      label: `Case ${cur.n || i + 1}`,
      input,
      output,
    });
  }

  if (!title && !instruction && !starterCode) return null;
  if (testCases.length < 1) return null;

  return {
    title: title || "Coding Problem",
    instruction,
    starterCode,
    testCases: testCases.slice(0, 3),
  };
}
