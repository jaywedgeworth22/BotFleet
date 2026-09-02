import re

with open('ios/App/AgentProfileView.swift', 'r') as f:
    content = f.read()

# Add fallbacks state
content = content.replace(
    '@State private var modelId: String',
    '@State private var modelId: String\n    @State private var fallbacks: [ModelSelection]'
)

# Initialize fallbacks state
content = content.replace(
    '_modelId = State(initialValue: bot.modelSelection.model)',
    '_modelId = State(initialValue: bot.modelSelection.model)\n        _fallbacks = State(initialValue: bot.modelSelection.fallbacks ?? [])'
)

# Update fallbacks in synchronizeForm
content = content.replace(
    'modelId = bot.modelSelection.model',
    'modelId = bot.modelSelection.model\n        fallbacks = bot.modelSelection.fallbacks ?? []'
)

# Replace the "Model" Section with fallbacks UI
model_section_regex = re.compile(r'Section\("Model"\) \{.*?\n                \}', re.DOTALL)
model_section_replacement = """Section("Model") {
                    if instances.isEmpty {
                        Text("Loading models...")
                            .foregroundStyle(.secondary)
                    } else {
                        Picker("Provider", selection: $instanceId) {
                            ForEach(instances) { instance in
                                Text(instance.displayName ?? instance.instanceId).tag(instance.id)
                            }
                        }
                        .onChange(of: instanceId) { _, newInstanceId in
                            if let instance = instances.first(where: { $0.id == newInstanceId }) {
                                if !instance.models.options.contains(where: { $0.id == modelId }) {
                                    modelId = instance.models.default
                                }
                            }
                        }

                        if let selectedInstance = instances.first(where: { $0.id == instanceId }) {
                            Picker("Model", selection: $modelId) {
                                ForEach(selectedInstance.models.options) { option in
                                    Text(option.label).tag(option.id)
                                }
                            }
                        }
                        
                        ForEach(fallbacks.indices, id: \\.self) { index in
                            let fallback = fallbacks[index]
                            if let instance = instances.first(where: { $0.id == fallback.instanceId }) {
                                Picker("Fallback \\(index + 1)", selection: Binding(
                                    get: { fallback.model },
                                    set: { newModel in
                                        fallbacks[index].model = newModel
                                    }
                                )) {
                                    ForEach(instance.models.options) { option in
                                        Text(option.label).tag(option.id)
                                    }
                                }
                                .swipeActions {
                                    Button(role: .destructive) {
                                        fallbacks.remove(at: index)
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            }
                        }
                        
                        if fallbacks.count < 2 {
                            Button("Add fallback") {
                                fallbacks.append(ModelSelection(instanceId: instanceId, model: modelId))
                            }
                        }
                    }
                }"""
content = model_section_regex.sub(model_section_replacement, content)

# Update newModelSelection in profilePatch
content = content.replace(
    'let newModelSelection = ModelSelection(instanceId: instanceId, model: modelId)',
    'let newModelSelection = ModelSelection(instanceId: instanceId, model: modelId, fallbacks: fallbacks.isEmpty ? nil : fallbacks)'
)

with open('ios/App/AgentProfileView.swift', 'w') as f:
    f.write(content)

