/**
 * Modern Coreutils Extension - Redirects find/grep to fd/rg
 *
 * Complements the PATH shims in intercepted-commands/ (which the uv extension
 * already prepends to PATH) by catching explicit-path invocations like
 * /usr/bin/find or /usr/bin/grep that bypass the shims.
 *
 * Uses the tool_call event so it composes with the uv extension's bash tool
 * override without conflict.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";

const findPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?find\s+/m;
const grepPattern = /(?:^|\n|[;|&]{1,2})\s*(?:\S+\/)?grep\s+/m;
const pipedGrepPattern = /\|\s*(?:\S+\/)?grep\s+/m;

function getBlockReason(command: string): string | null {
  if (findPattern.test(command)) {
    return [
      "Error: find is disabled. Use fd instead:",
      "",
      "  To find files by name:     fd PATTERN",
      "  To find by extension:      fd -e ext",
      "  To find in a directory:    fd PATTERN /path/to/dir",
      "  To find with type filter:  fd -t f PATTERN  (files only)",
      "                             fd -t d PATTERN  (dirs only)",
      "  To include hidden files:   fd -H PATTERN",
      "  To include ignored files:  fd -I PATTERN",
      "",
    ].join("\n");
  }

  if (grepPattern.test(command) || pipedGrepPattern.test(command)) {
    return [
      "Error: grep is disabled. Use rg (ripgrep) instead:",
      "",
      "  To search for a pattern:      rg PATTERN",
      "  To search in a directory:     rg PATTERN /path/to/dir",
      "  To search specific file type: rg PATTERN -t py",
      "  To search with context:       rg -C 3 PATTERN",
      "  To search case-insensitive:   rg -i PATTERN",
      "  To search for fixed string:   rg -F 'literal string'",
      "  To list matching files only:  rg -l PATTERN",
      "  To include hidden files:      rg --hidden PATTERN",
      "",
    ].join("\n");
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (isToolCallEventType("bash", event)) {
      const reason = getBlockReason(event.input.command);
      if (reason) {
        return { block: true, reason };
      }
    }
  });
}
