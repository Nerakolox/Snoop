import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/keyboard.css";
import Keyboard3D from "./components/keyboard/Keyboard3D";
import { KeySelectionProvider } from "./components/keyboard/KeySelectionContext";
import type { LayoutKey } from "./keyboardLayout";

// 104 键标准布局（简化版）
const KEYS: LayoutKey[] = (() => {
  const keys: LayoutKey[] = [];

  // 功能行 row=0
  const fnRow: [number, string, string][] = [
    [0,"Escape","Esc"],[2,"F1","F1"],[3,"F2","F2"],[4,"F3","F3"],[5,"F4","F4"],
    [6.5,"F5","F5"],[7.5,"F6","F6"],[8.5,"F7","F7"],[9.5,"F8","F8"],
    [11,"F9","F9"],[12,"F10","F10"],[13,"F11","F11"],[14,"F12","F12"],
  ];
  fnRow.forEach(([x, code, lower]) => keys.push({ x, y: 0, w: 1, h: 1, code, lower, upper: lower, row: 0 }));

  // 数字行 row=1
  const numRow: [string,string,string][] = [
    ["Backquote","`","~"],["Digit1","1","!"],["Digit2","2","@"],["Digit3","3","#"],
    ["Digit4","4","$"],["Digit5","5","%"],["Digit6","6","^"],["Digit7","7","&"],
    ["Digit8","8","*"],["Digit9","9","("],["Digit0","0",")"],["Minus","-","_"],["Equal","=","+"],
  ];
  numRow.forEach(([code, lower, upper], i) => keys.push({ x: i, y: 1.25, w: 1, h: 1, code, lower, upper, row: 1 }));
  keys.push({ x: 13, y: 1.25, w: 2, h: 1, code: "Backspace", lower: "Backspace", upper: "Backspace", row: 1 });

  // QWERTY row=2
  keys.push({ x: 0, y: 2.25, w: 1.5, h: 1, code: "Tab", lower: "Tab", upper: "Tab", row: 2 });
  const qRow = ["Q","W","E","R","T","Y","U","I","O","P"];
  qRow.forEach((l, i) => keys.push({ x: 1.5 + i, y: 2.25, w: 1, h: 1, code: `Key${l}`, lower: l.toLowerCase(), upper: l, row: 2 }));
  keys.push({ x: 11.5, y: 2.25, w: 1, h: 1, code: "BracketLeft",  lower: "[", upper: "{", row: 2 });
  keys.push({ x: 12.5, y: 2.25, w: 1, h: 1, code: "BracketRight", lower: "]", upper: "}", row: 2 });
  keys.push({ x: 13.5, y: 2.25, w: 1.5, h: 1, code: "Backslash",  lower: "\\", upper: "|", row: 2 });

  // Home row=3
  keys.push({ x: 0, y: 3.25, w: 1.75, h: 1, code: "CapsLock", lower: "Caps", upper: "Caps", row: 3 });
  const homeRow = ["A","S","D","F","G","H","J","K","L"];
  homeRow.forEach((l, i) => keys.push({ x: 1.75 + i, y: 3.25, w: 1, h: 1, code: `Key${l}`, lower: l.toLowerCase(), upper: l, row: 3 }));
  keys.push({ x: 10.75, y: 3.25, w: 1, h: 1, code: "Semicolon", lower: ";", upper: ":", row: 3 });
  keys.push({ x: 11.75, y: 3.25, w: 1, h: 1, code: "Quote",     lower: "'", upper: '"', row: 3 });
  keys.push({ x: 12.75, y: 3.25, w: 2.25, h: 1, code: "Enter",  lower: "Enter", upper: "Enter", row: 3 });

  // Shift row=4
  keys.push({ x: 0, y: 4.25, w: 2.25, h: 1, code: "ShiftLeft", lower: "Shift", upper: "Shift", row: 4 });
  const shiftRow = ["Z","X","C","V","B","N","M"];
  shiftRow.forEach((l, i) => keys.push({ x: 2.25 + i, y: 4.25, w: 1, h: 1, code: `Key${l}`, lower: l.toLowerCase(), upper: l, row: 4 }));
  keys.push({ x: 9.25, y: 4.25, w: 1, h: 1, code: "Comma",      lower: ",", upper: "<", row: 4 });
  keys.push({ x: 10.25, y: 4.25, w: 1, h: 1, code: "Period",    lower: ".", upper: ">", row: 4 });
  keys.push({ x: 11.25, y: 4.25, w: 1, h: 1, code: "Slash",     lower: "/", upper: "?", row: 4 });
  keys.push({ x: 12.25, y: 4.25, w: 2.75, h: 1, code: "ShiftRight", lower: "Shift", upper: "Shift", row: 4 });

  // Space row=5
  keys.push({ x: 0,     y: 5.25, w: 1.25, h: 1, code: "ControlLeft",  lower: "Ctrl",  upper: "Ctrl",  row: 5 });
  keys.push({ x: 1.25,  y: 5.25, w: 1.25, h: 1, code: "MetaLeft",     lower: "Win",   upper: "Win",   row: 5 });
  keys.push({ x: 2.5,   y: 5.25, w: 1.25, h: 1, code: "AltLeft",      lower: "Alt",   upper: "Alt",   row: 5 });
  keys.push({ x: 3.75,  y: 5.25, w: 6.25, h: 1, code: "Space",        lower: "",      upper: "",      row: 5 });
  keys.push({ x: 10,    y: 5.25, w: 1.25, h: 1, code: "AltRight",     lower: "Alt",   upper: "Alt",   row: 5 });
  keys.push({ x: 11.25, y: 5.25, w: 1.25, h: 1, code: "MetaRight",    lower: "Win",   upper: "Win",   row: 5 });
  keys.push({ x: 12.5,  y: 5.25, w: 1.25, h: 1, code: "ContextMenu",  lower: "Menu",  upper: "Menu",  row: 5 });
  keys.push({ x: 13.75, y: 5.25, w: 1.25, h: 1, code: "ControlRight", lower: "Ctrl",  upper: "Ctrl",  row: 5 });

  return keys;
})();

const maxX = 15;
const maxY = 6.25;

// LCG 合成计数，模拟热力分布
const keyCounts: Record<string, number> = {};
let seed = 20261018;
KEYS.forEach((k, i) => {
  seed = (seed * 1664525 + 1013904223) & 0xffffffff;
  const base = Math.abs(seed % 800);
  if (k.code) keyCounts[k.code] = i % 17 === 0 ? base + 4200 : base;
});
const allKeyCounts = Object.values(keyCounts);

const p = new URLSearchParams(location.search);
const heightMode = p.get("height") === "1";

function Preview() {
  return (
    <KeySelectionProvider value={{}}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100vw", minHeight: "100vh" }}>
        <div style={{ width: "90vw", maxWidth: "1200px" }}>
          <Keyboard3D
            keys={KEYS}
            keyCounts={heightMode ? keyCounts : {}}
            allKeyCounts={heightMode ? allKeyCounts : []}
            maxX={maxX}
            maxY={maxY}
          />
        </div>
      </div>
    </KeySelectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><Preview /></StrictMode>
);
