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
          `Blocked: Path "${targetPath}" is outside project root`,
          "warning"
        );
      }
      return {
        block: true,
        reason: `Path "${targetPath}" is outside the project root`,
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
    // Commands that create/write files
    const writeCommands = [
      "touch",
      "cp",
      "mv",
      "mkdir",
      "rm",
      "rmdir",
      "tee",
    ];

    // Check for redirection operators (>, >>)
    const hasRedirection = />|>>/.test(command);

    // Extract potential file paths from the command
    // Match quoted strings, unquoted paths, and paths after redirection operators
    const pathRegex = /(?:^|[;|&]|\$\()\s*(\w+)\s+(?:"([^"]+)"|'([^']+)'|([^\s>;|&]+))/g;
    const redirectRegex = />+\s*(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/g;

    let match;

    // Check commands
    while ((match = pathRegex.exec(command)) !== null) {
      const cmd = match[1];
      const filePath = match[2] || match[3] || match[4];

      if (writeCommands.includes(cmd) && filePath) {
        const result = validatePath(filePath, ctx, allowedPaths);
        if (result) return result;
      }
    }

    // Check redirection targets
    if (hasRedirection) {
      while ((match = redirectRegex.exec(command)) !== null) {
        const filePath = match[1] || match[2] || match[3];
        if (filePath) {
          const result = validatePath(filePath, ctx, allowedPaths);
          if (result) return result;
        }
      }
    }

    return undefined;
  }
}
