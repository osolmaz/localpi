/**
 * Continue a reply that the model cut off at the declared output limit.
 *
 * Pi ends the agent run when a turn stops at the output cap without asking for a tool, so a
 * half-written reply becomes the whole answer. This extension asks the model to continue after
 * such a turn, at most `limit` times per session. The limit lives in the generated source, so the
 * extension carries no extra environment variable into the Pi child.
 */
export function continueOnTruncationExtensionSource(
  limit: number,
  cappedProviders: readonly string[] = []
): string {
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const limit = ${String(limit)};
const cappedProviders = new Set<string>(${JSON.stringify(cappedProviders)});

const nudge = [
  "You hit the output limit before finishing.",
  "Continue from where you stopped.",
  "Do not repeat earlier text. Take the next tool call or write the answer."
].join(" ");

export default function localpiContinueOnTruncation(pi: ExtensionAPI): void {
  let continued = 0;
  let limitReported = false;

  pi.on("session_start", () => {
    continued = 0;
    limitReported = false;
  });

  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant" || event.message.stopReason !== "length") {
      return;
    }
    // The stop-thinking extension owns this thinking-only length stop. A generic follow-up
    // would race its answer-only continuation and spend the reserved answer budget twice.
    if (cappedProviders.has(ctx?.model?.provider ?? "") &&
        pi.getThinkingLevel() !== "off" &&
        event.message.content.some((part) => part.type === "thinking") &&
        !event.message.content.some((part) =>
          part.type === "toolCall" || (part.type === "text" && part.text.trim().length > 0))) {
      return;
    }
    // A turn that already asked for tools keeps running on its own.
    if (event.toolResults.length > 0) {
      return;
    }
    if (continued >= limit) {
      if (!limitReported) {
        limitReported = true;
        const plural = continued === 1 ? "" : "s";
        process.stderr.write(
          \`localpi: reply was cut off again after \${continued} continuation\${plural}; stopping now\\n\`
        );
      }
      return;
    }
    continued += 1;
    process.stderr.write(
      \`localpi: reply was cut off by the output limit; continuing (\${continued}/\${limit})\\n\`
    );
    pi.sendUserMessage(nudge, { deliverAs: "followUp" });
  });
}
`;
}
