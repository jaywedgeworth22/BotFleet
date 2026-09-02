import re

with open('ios/App/AgentProfileView.swift', 'r') as f:
    content = f.read()

# Add Usage Section right before "Save profile"
usage_ui = """
                if let tasks = current.tasks, !tasks.isEmpty {
                    let totalTurns = tasks.compactMap { $0.usage?.turns }.reduce(0, +)
                    let totalInput = tasks.compactMap { $0.usage?.input }.reduce(0, +)
                    let totalOutput = tasks.compactMap { $0.usage?.output }.reduce(0, +)
                    let totalCost = tasks.compactMap { $0.usage?.costUsd }.reduce(0, +)
                    let hasCost = tasks.contains(where: { $0.usage?.costUsd != nil })
                    
                    if totalTurns > 0 {
                        Section("Usage") {
                            HStack {
                                Text("Turns")
                                Spacer()
                                Text("\\(totalTurns)")
                                    .foregroundStyle(.secondary)
                            }
                            HStack {
                                Text("Tokens")
                                Spacer()
                                Text("\\((totalInput + totalOutput) / 1000)k (\\(totalInput / 1000)k in, \\(totalOutput / 1000)k out)")
                                    .foregroundStyle(.secondary)
                            }
                            if hasCost {
                                HStack {
                                    Text("Cost")
                                    Spacer()
                                    Text(String(format: "$%.2f", totalCost))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                Section {"""

content = content.replace('                Section {\n                    Button("Save profile")', usage_ui + '\n                    Button("Save profile")')

with open('ios/App/AgentProfileView.swift', 'w') as f:
    f.write(content)

