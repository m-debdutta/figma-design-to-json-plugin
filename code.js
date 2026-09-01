figma.showUI(__html__, {
  width: 360,
  height: 320,
  title: "Figma JSON Exporter",
  themeColors: true
});

function getSelectedNode() {
  const selection = figma.currentPage.selection;

  if (selection.length === 0) {
    return null;
  }

  if (selection.length > 1) {
    return "MULTIPLE";
  }

  return selection[0];
}

function toFileName(name) {
  const cleaned = String(name || "")
    .replace(/[^a-z0-9 _-]/gi, "")
    .trim()
    .replace(/\s+/g, "-");

  return cleaned ? cleaned + ".json" : "figma-design.json";
}

figma.ui.onmessage = async (message) => {
  if (!message || message.type !== "export-request") {
    return;
  }

  const node = getSelectedNode();

  if (!node) {
    figma.ui.postMessage({
      type: "error",
      message: "Please select a frame first."
    });

    return;
  }

  if (node === "MULTIPLE") {
    figma.ui.postMessage({
      type: "error",
      message: "Please select only one frame."
    });

    return;
  }

  if (typeof node.exportAsync !== "function") {
    figma.ui.postMessage({
      type: "error",
      message: 'The selected "' + node.type + '" node cannot be exported.'
    });

    return;
  }

  try {
    const json = await node.exportAsync({
      format: "JSON_REST_V1"
    });

    figma.ui.postMessage({
      type: "export-result",
      fileName: toFileName(node.name),
      data: json
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to export the selected node."
    });
  }
};
