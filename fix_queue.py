import re

with open("src/state/bot-patch-queue.ts", "r") as f:
    bpq = f.read()

bpq = bpq.replace('| "computer"', '| "computers"')

with open("src/state/bot-patch-queue.ts", "w") as f:
    f.write(bpq)
