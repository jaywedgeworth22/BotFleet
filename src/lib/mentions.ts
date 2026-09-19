// Mention and tag definitions, regex, and markdown plugin for @ (Bots) and # (Apps/Channels).

export const MENTION_REGEX = /(?:^|(?<=[\s(\[\"'“‘]))([@#][a-zA-Z0-9_\-\.]+)(?=$|[\s)\]\"'”’.,:;!?])/g;

export const MENTION_CLASS = "font-bold text-[1.05em] text-accent inline-block align-baseline";

/**
 * Remark plugin that transforms @bot and #channel/#app tokens in markdown
 * text nodes into styled bolder and slightly larger mention spans.
 * Leaves code blocks, inline code, and links unmodified.
 */
export function remarkMentions() {
  return (tree: any) => {
    function visit(node: any) {
      if (!node || !node.children) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (child.type === "text" && typeof child.value === "string") {
          const parts = child.value.split(MENTION_REGEX);
          if (parts.length > 1) {
            const newChildren = parts
              .map((part: string) => {
                if (part && (part.startsWith("@") || part.startsWith("#")) && /^[@#][a-zA-Z0-9_\-\.]+$/.test(part)) {
                  return {
                    type: "textDirective",
                    data: {
                      hName: "span",
                      hProperties: {
                        className: MENTION_CLASS,
                      },
                    },
                    children: [{ type: "text", value: part }],
                  };
                }
                return { type: "text", value: part };
              })
              .filter((p: { type: string; value?: string }) => p.value !== "");
            node.children.splice(i, 1, ...newChildren);
            i += newChildren.length - 1;
          }
        } else if (child.type !== "code" && child.type !== "inlineCode") {
          visit(child);
        }
      }
    }
    visit(tree);
  };
}
