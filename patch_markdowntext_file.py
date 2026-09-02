import re

with open('ios/App/MarkdownText.swift', 'r') as f:
    content = f.read()

# Add states for alert
content = content.replace(
    'var caret: Bool = false',
    'var caret: Bool = false\n    @State private var fileLink: URL?\n    @State private var showingFileAlert = false\n    @Environment(\\.openURL) private var openURL'
)

# Intercept openURL in the body
body_regex = re.compile(r'(var body: some View \{.*?)(\n    @ViewBuilder)', re.DOTALL)
body_replacement = r'''\1
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == "file" {
                fileLink = url
                showingFileAlert = true
                return .handled
            }
            return .systemAction
        })
        .alert("Cannot open file on phone", isPresented: $showingFileAlert, presenting: fileLink) { _ in
            Button("OK", role: .cancel) { }
        } message: { url in
            Text("The file '\(url.lastPathComponent)' is on your computer. You can only view it from the desktop app.")
        }\2'''

content = body_regex.sub(body_replacement, content)

with open('ios/App/MarkdownText.swift', 'w') as f:
    f.write(content)

