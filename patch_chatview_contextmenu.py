import re

with open('ios/App/ChatView.swift', 'r') as f:
    content = f.read()

context_menu_regex = re.compile(r'(\.contextMenu \{.*?)(        \}\n        \.alert\("Edit and retry")', re.DOTALL)

def replace_context_menu(m):
    original = m.group(1)
    addition = """
            if let reqId = message.card?.requestId {
                Divider()
                Button("Copy Request ID", systemImage: "doc.on.doc") {
                    UIPasteboard.general.string = reqId
                }
            }
"""
    return original + addition + m.group(2)

content = context_menu_regex.sub(replace_context_menu, content)

with open('ios/App/ChatView.swift', 'w') as f:
    f.write(content)

