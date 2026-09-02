import re

with open('ios/App/GroupProfileView.swift', 'r') as f:
    content = f.read()

# Add extraCwds states
content = content.replace(
    '@State private var cwd = ""',
    '@State private var cwd = ""\n    @State private var extraCwdsText = ""'
)

# Initialize extraCwdsText
content = content.replace(
    'cwd = room.cwd ?? ""',
    'cwd = room.cwd ?? ""\n                extraCwdsText = room.extraCwds?.joined(separator: "\\n") ?? ""'
)

# Update currentRoom
content = content.replace(
    'r.cwd = cwd.isEmpty ? nil : cwd',
    'r.cwd = cwd.isEmpty ? nil : cwd\n        r.extraCwds = extraCwdsText.isEmpty ? nil : extraCwdsText.components(separatedBy: .newlines).filter({ !$0.trimmingCharacters(in: .whitespaces).isEmpty })'
)

# Update UI
working_directory_section = """                Section("Working Directory") {
                    TextField("Folder path on host (optional)", text: $cwd)
                        .disabled(busy)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
                
                Section("Additional Repositories") {
                    TextField("One path per line", text: $extraCwdsText, axis: .vertical)
                        .disabled(busy)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .lineLimit(3...8)
                }"""

content = re.sub(r'                Section\("Working Directory"\) \{.*?\n                \}', working_directory_section, content, flags=re.DOTALL)

with open('ios/App/GroupProfileView.swift', 'w') as f:
    f.write(content)

