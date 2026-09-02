import re

with open("server/drivers/acp/dsh.ts", "r") as f:
    text = f.read()

text = re.sub(r'export const STATIC_DSH_MODELS: ModelCatalog = \{[\s\S]*?options: \[[\s\S]*?\],\n\};', """export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek-V4-Flash-Vision-Exp" },
  ],
};""", text)

with open("server/drivers/acp/dsh.ts", "w") as f:
    f.write(text)
