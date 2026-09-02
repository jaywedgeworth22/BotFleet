import re

with open('src/components/CursorMark.tsx', 'r') as f:
    content = f.read()

content = 'import cursorMark from "/cursor-mark.png";\n' + content
content = content.replace('src="/cursor-mark.png"', 'src={cursorMark}')

with open('src/components/CursorMark.tsx', 'w') as f:
    f.write(content)
