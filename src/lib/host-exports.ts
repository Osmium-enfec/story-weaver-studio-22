import path from "node:path";
import { hostDataRoot } from "@/lib/host-storage";

export function hostExportsRoot(): string {
  return path.join(hostDataRoot(), "exports");
}
