export function initialPetState() {
  return {
    phase: "idle",
    activeTools: 0,
    lastTool: "",
    children: 0
  };
}

export function reducePetState(state, event) {
  switch (event.type) {
    case "agent-start":
      return { ...state, phase: state.children ? "children" : "thinking" };
    case "tool-start":
      return {
        ...state,
        phase: state.children ? "children" : "tool",
        activeTools: state.activeTools + 1,
        lastTool: event.toolName ?? "tool"
      };
    case "tool-end": {
      const activeTools = Math.max(0, state.activeTools - 1);
      return {
        ...state,
        activeTools,
        phase: event.isError
          ? "error"
          : state.children
            ? "children"
            : activeTools
              ? "tool"
              : "thinking"
      };
    }
    case "subagent-start":
      return { ...state, children: state.children + 1, phase: "children" };
    case "subagent-complete": {
      const children = Math.max(0, state.children - 1);
      return {
        ...state,
        children,
        phase: children ? "children" : state.activeTools ? "tool" : "thinking"
      };
    }
    case "agent-settled":
      return { ...state, phase: "done", activeTools: 0 };
    case "reset":
      return initialPetState();
    default:
      return state;
  }
}

function counts(state) {
  const items = [];
  if (state.children) items.push(`${state.children} ${state.children === 1 ? "pup" : "pups"}`);
  if (state.activeTools) {
    items.push(`${state.activeTools} ${state.activeTools === 1 ? "tool" : "tools"}`);
  }
  return items.join(" · ");
}

export function petLabel(state) {
  if (state.children) return `ᵔᴥᵔ ${counts(state)}`;
  if (state.phase === "error") return "×ᴥ× tool error";
  if (state.phase === "tool") {
    return state.activeTools > 1 ? `•ᴥ• ${state.activeTools} tools` : `•ᴥ• ${state.lastTool}`;
  }
  if (state.phase === "thinking") return "◔ᴥ◔ thinking";
  if (state.phase === "done") return "ᵔᴥᵔ done";
  return "ᵔᴥᵔ ready";
}
