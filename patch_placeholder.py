import re

with open('src/components/GroupView.tsx', 'r') as f:
    content = f.read()

content = content.replace('"Each bot\'s own folder"', '"e.g. /Users/jay/Code/MyProject"')
content = content.replace('>Each bot\'s own folder<', '>Individual bot defaults<')
content = content.replace('"Each bot\'s own folder — or an absolute path"', '"e.g. /Users/jay/Code/MyProject"')

with open('src/components/GroupView.tsx', 'w') as f:
    f.write(content)
