import re

with open("server/index.ts", "r") as f:
    text = f.read()

old_validate = """      if (
        body.computer !== undefined &&
        !["cloud", "vm", "local", "off"].includes(String(body.computer))
      ) {
        return json(res, 400, { error: "computer must be cloud, vm, local, or off" });
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {"""

new_validate = """      if (body.computers !== undefined) {
        if (!Array.isArray(body.computers) || body.computers.some((c: unknown) => !["cloud", "vm", "local"].includes(String(c)))) {
          return json(res, 400, { error: "computers must be an array containing cloud, vm, or local" });
        }
        patch.computers = [...new Set(body.computers as ("cloud" | "vm" | "local")[])];
      }
      if (body.cloudBackend !== undefined && !["box", "vps"].includes(String(body.cloudBackend))) {"""

text = text.replace(old_validate, new_validate)

with open("server/index.ts", "w") as f:
    f.write(text)

with open("server/index.test.ts", "r") as f:
    test_text = f.read()

test_text = test_text.replace('computer: "local"', 'computers: ["local"]')
test_text = test_text.replace('computer: "off"', 'computers: []')

with open("server/index.test.ts", "w") as f:
    f.write(test_text)
