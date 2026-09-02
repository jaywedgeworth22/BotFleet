import re

with open('ios/App/ChatView.swift', 'r') as f:
    content = f.read()

# Add showingRoutines state
content = content.replace(
    '@State private var showingTasks = false',
    '@State private var showingTasks = false\n    @State private var showingRoutines = false'
)

# Add PlusAction
plus_action = """            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })
            out.append(PlusAction(
                id: "routines", systemImage: "calendar.badge.clock", title: "Tasks & Routines",
                subtitle: "Automate tasks on a schedule"
            ) { showingRoutines = true })"""

content = content.replace(
    '''            out.append(PlusAction(
                id: "tasks", systemImage: "square.stack", title: "Tasks",
                subtitle: "Switch, rename or remove one"
            ) { showingTasks = true })''',
    plus_action
)

# Add navigation destination
navigation_dest = """        .sheet(isPresented: $showingTasks) {
            if case let .bot(bot) = current { TaskManagerView(bot: bot) }
        }
        .navigationDestination(isPresented: $showingRoutines) {
            TasksRoutinesView()
        }"""

content = content.replace(
    '''        .sheet(isPresented: $showingTasks) {
            if case let .bot(bot) = current { TaskManagerView(bot: bot) }
        }''',
    navigation_dest
)

with open('ios/App/ChatView.swift', 'w') as f:
    f.write(content)

