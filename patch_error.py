import re

with open("src/state/store.tsx", "r") as f:
    content = f.read()

# Remove the setTimeout from onError and showError
content = re.sub(r'setTimeout\(\(\) => rawDispatch\(\{ type: "error", message: null \}\), 6000\);\n', '', content)

with open("src/state/store.tsx", "w") as f:
    f.write(content)

with open("src/components/ChatView.tsx", "r") as f:
    chat_content = f.read()

# Remove the error banner from ChatView
chat_content = re.sub(r'\{\/\* Error banner \*\/\}\n\s*\{state\.error && \(\n\s*<div className="w-full px-5">\n\s*<div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-\[13px\] text-danger">\n\s*\{state\.error\}\n\s*<\/div>\n\s*<\/div>\n\s*\)\}\n', '', chat_content)

with open("src/components/ChatView.tsx", "w") as f:
    f.write(chat_content)
