import re

with open("server/drivers/acp/dsh.ts", "r") as f:
    text = f.read()

old = """export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash", label: "DeepSeek-V4-Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek-V4-Flash-Vision-Exp (Experimental)" },
  ],
};"""

new = """export const STATIC_DSH_MODELS: ModelCatalog = {
  default: "deepseek-v4-flash",
  options: [
    { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { id: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { id: "deepseek-v4-flash-vision-exp", label: "DeepSeek-V4-Flash-Vision-Exp (Experimental)" },
  ],
};"""

text = text.replace(old, new)
with open("server/drivers/acp/dsh.ts", "w") as f:
    f.write(text)

with open("server/drivers/acp/dsh.test.ts", "r") as f:
    test_text = f.read()

test_old = """      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);"""
test_new = """      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]);"""
test_text = test_text.replace(test_old, test_new)
with open("server/drivers/acp/dsh.test.ts", "w") as f:
    f.write(test_text)
