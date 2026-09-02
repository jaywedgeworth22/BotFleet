import re

with open('ios/App/MarkdownText.swift', 'r') as f:
    content = f.read()

# Fix the body syntax
broken = """        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \\.offset) { item in
                view(for: item.element, tail: caret && item.offset == blocks.count - 1)
            }
        }
    }

        .environment"""

fixed = """        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \\.offset) { item in
                view(for: item.element, tail: caret && item.offset == blocks.count - 1)
            }
        }
        .environment"""

content = content.replace(broken, fixed)

with open('ios/App/MarkdownText.swift', 'w') as f:
    f.write(content)

