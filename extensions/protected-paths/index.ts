/**
 * Protected Paths Extension
 *
 * Restricts write and edit operations to only allowed paths (whitelist).
 * Blocks by default - only paths matching allowed glob patterns are permitted.
 * Also blocks paths that escape the project root (e.g., ../outside).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import picomatch from "picomatch";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  // Configure allowed paths using glob patterns
  // Default: only files in current folder ("." matches everything under cwd)
  const allowedPaths: string[] = ["."];

  pi.on("tool_call", async (event, ctx) => {
    // Handle write and edit tools
    if (event.toolName === "write" || event.toolName === "edit") {
      const targetPath = event.input.path as string;
      return validatePath(targetPath, ctx, allowedPaths);
    }

    // Handle bash commands that may write files (e.g., touch, >, >>)
    if (event.toolName === "bash") {
      const command = event.input.command as string;
      const blockedCommand = checkBashCommand(command, ctx, allowedPaths);
      if (blockedCommand) {
        return blockedCommand;
      }
    }

    return undefined;
  });

  function validatePath(
    targetPath: string,
    ctx: any,
    allowedPaths: string[]
  ): { block: true; reason: string } | undefined {
    const absoluteTargetPath = path.resolve(targetPath);

    // Check for path traversal outside project root
    // Paths must be under cwd (ctx.cwd)
    const relativeToCwd = path.relative(ctx.cwd, absoluteTargetPath);
    if (relativeToCwd.startsWith("..") || path.isAbsolute(relativeToCwd)) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Blocked: Path "${targetPath}" is outside project root. Create this file/folder in the current folder instead to proceed.`,
          "warning"
        );
      }
      return {
        block: true,
        reason: `Path "${targetPath}" is outside the project root. Create this file/folder in the current folder instead to proceed.`,
      };
    }

    // Check if path matches any allowed pattern
    // Convert relative path for matching (remove leading ./ if present)
    const cleanRelativePath = relativeToCwd.replace(/^\.\//, "");
    const isAllowed = allowedPaths.some((pattern) => {
      // Match either the full relative path or with **/ prefix for deep matching
      return (
        picomatch.isMatch(cleanRelativePath, pattern) ||
        picomatch.isMatch(cleanRelativePath, `**/${pattern}`) ||
        picomatch.isMatch(cleanRelativePath, `${pattern}/**`) ||
        picomatch.isMatch(targetPath, pattern)
      );
    });

    if (!isAllowed) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Blocked: Path "${targetPath}" is not in allowed paths [${allowedPaths.join(", ")}]`,
          "warning"
        );
      }
      return {
        block: true,
        reason: `Path "${targetPath}" is not in allowed paths [${allowedPaths.join(", ")}]`,
      };
    }

    return undefined;
  }

  function checkBashCommand(
    command: string,
    ctx: any,
    allowedPaths: string[]
  ): { block: true; reason: string } | undefined {
    // Extract ALL potential file paths from the command and validate them
    // This catches any command that operates on files, not just a whitelist

    // Match: quoted strings, unquoted paths (starts with ./, ../, /, or contains /)
    // Also matches paths after redirection operators (> >> <)
    const pathPatterns = [
      // Quoted paths: "path/to/file" or '/path/to/file'
      /"([^"]+)"/g,
      /'([^']+)'/g,
      // Redirection targets: > path, >> path, < path
      /[<>]+\s*([^\s;|&<>]+)/g,
      // Unquoted paths that look like file paths (contain / or start with ./ ../)
      /(?:^|[;|&]|\$\()\s*([^\s;|&<>\"']+(?:\/[^\s;|&<>\"']+)+)/g,
      // Paths starting with ./ or ../ or /
      /(?:^|[;|&]|\s)(\.\/[^\s;|&<>\"']*|\.\.\/[^\s;|&<>\"']*|\/[^\s;|&<>\"']+)/g,
    ];

    const seenPaths = new Set<string>();

    for (const pattern of pathPatterns) {
      let match;
      while ((match = pattern.exec(command)) !== null) {
        const potentialPath = match[1]?.trim();
        if (potentialPath && !seenPaths.has(potentialPath)) {
          seenPaths.add(potentialPath);

          // Skip if it looks like a flag/option
          if (potentialPath.startsWith("-")) continue;

          // Skip common non-file strings
          if (/^(true|false|null|undefined|http|https|ftp|git|ssh):/.test(potentialPath)) continue;

          // Validate the path
          const result = validatePath(potentialPath, ctx, allowedPaths);
          if (result) return result;
        }
      }
    }

    return undefined;
  }
}
