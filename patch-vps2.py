import re

with open("server/vps-routing.test.ts", "r") as f:
    text = f.read()

text = text.replace("4 * 1024 * 1024 * 1024", "8 * 1024 * 1024 * 1024")
text = text.replace("2_000_000_000", "4_000_000_000")

with open("server/vps-routing.test.ts", "w") as f:
    f.write(text)
