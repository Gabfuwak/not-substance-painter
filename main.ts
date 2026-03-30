document.addEventListener("DOMContentLoaded", () => {
  const dividerElement = document.getElementById("panel-divider");
  const rightPanelElement = document.getElementById("right-panel");

  if (!(dividerElement instanceof HTMLElement) || !(rightPanelElement instanceof HTMLElement)) {
    return;
  }

  const divider = dividerElement;
  const rightPanel = rightPanelElement;

  const MIN_RIGHT_WIDTH = 260;
  const MAX_RIGHT_WIDTH = 700;
  const MIN_CENTER_WIDTH = 360;
  const KEYBOARD_STEP = 24;

  const clamp = (value: number, min: number, max: number): number => {
    return Math.min(Math.max(value, min), max);
  };

  function getMaxRightWidth(): number {
    const bodyWidth = document.body.getBoundingClientRect().width;
    return Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, bodyWidth - MIN_CENTER_WIDTH));
  }

  function setRightPanelWidth(width: number): void {
    const nextWidth = clamp(width, MIN_RIGHT_WIDTH, getMaxRightWidth());
    document.documentElement.style.setProperty("--right-panel-width", `${nextWidth}px`);
    divider.setAttribute("aria-valuemin", String(MIN_RIGHT_WIDTH));
    divider.setAttribute("aria-valuemax", String(getMaxRightWidth()));
    divider.setAttribute("aria-valuenow", String(Math.round(nextWidth)));
  }

  function widthFromPointer(clientX: number): number {
    const bodyRect = document.body.getBoundingClientRect();
    return bodyRect.right - clientX;
  }

  function stopResize(pointerId: number): void {
    document.body.classList.remove("is-resizing");

    if (divider.hasPointerCapture(pointerId)) {
      divider.releasePointerCapture(pointerId);
    }
  }

  setRightPanelWidth(rightPanel.getBoundingClientRect().width || 320);

  divider.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    document.body.classList.add("is-resizing");
    divider.setPointerCapture(event.pointerId);
    setRightPanelWidth(widthFromPointer(event.clientX));
  });

  divider.addEventListener("pointermove", (event: PointerEvent) => {
    if (!divider.hasPointerCapture(event.pointerId)) {
      return;
    }

    setRightPanelWidth(widthFromPointer(event.clientX));
  });

  divider.addEventListener("pointerup", (event: PointerEvent) => {
    stopResize(event.pointerId);
  });

  divider.addEventListener("pointercancel", (event: PointerEvent) => {
    stopResize(event.pointerId);
  });

  divider.addEventListener("keydown", (event: KeyboardEvent) => {
    const currentWidth = rightPanel.getBoundingClientRect().width;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRightPanelWidth(currentWidth + KEYBOARD_STEP);
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      setRightPanelWidth(currentWidth - KEYBOARD_STEP);
    }
  });

  window.addEventListener("resize", () => {
    setRightPanelWidth(rightPanel.getBoundingClientRect().width);
  });
});
