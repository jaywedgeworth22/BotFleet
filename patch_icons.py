import re

with open('src/components/ProviderIcons.tsx', 'r') as f:
    content = f.read()

# Replace src="/gemini-mark.webp" with imported version
if 'import geminiMark from' not in content:
    content = 'import geminiMark from "/gemini-mark.webp";\n' + content
    content = content.replace('src="/gemini-mark.webp"', 'src={geminiMark}')

if 'import codexMark from' not in content:
    content = 'import codexMark from "/codex-mark.png";\n' + content
    content = content.replace('src="/codex-mark.png"', 'src={codexMark}')

with open('src/components/ProviderIcons.tsx', 'w') as f:
    f.write(content)
