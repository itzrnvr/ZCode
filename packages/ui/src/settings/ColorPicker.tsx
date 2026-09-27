import { useEffect, useRef, useState } from "react";
import { Pipette, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { normalizeUiColor } from "@/lib/uiColors.js";
import { hexToHsv, hsvToHex, type Hsv } from "@/lib/colorModels.js";

interface EyeDropperResult {
  sRGBHex: string;
}
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> };

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * 取色器：SV 面板 + 色相滑条 + 十六进制输入 + 屏幕吸管 + 预设。
 * 取值以 hex 为准（store 只存 hex），HSV 仅作为拖拽过程中的编辑状态，
 * 因此外部改色（预设、主题、重置）会通过 value 回流并同步 HSV。
 */
export function ColorPicker({
  label,
  onChange,
  onReset,
  presets,
  value,
}: {
  /** 当前生效色（不含覆盖时为主题解析值） */
  label: string;
  onChange: (hex: string) => void;
  onReset: () => void;
  presets: readonly string[];
  value: string;
}) {
  const { intl } = useZCodeIntl();
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 0, s: 0, v: 0 });
  const [draft, setDraft] = useState(value);
  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);
  const frameRef = useRef(0);
  // 拖拽期间同一个渲染帧会收到多次 pointermove；闭包里的 hsv 会过期，
  // 因此编辑状态同时保存在 ref 里，事件处理一律读 ref。
  const hsvRef = useRef(hsv);

  const applyHsv = (next: Hsv) => {
    hsvRef.current = next;
    setHsv(next);
    const hex = hsvToHex(next);
    setDraft(hex);
    emit(hex);
  };

  // 拖拽时按帧合并写入：每帧最多一次 store 写入（localStorage + 跨窗口广播）。
  const emit = (hex: string) => {
    pendingRef.current = hex;
    if (frameRef.current !== 0) {
      return;
    }
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      const next = pendingRef.current;
      pendingRef.current = null;
      if (next !== null) {
        onChange(next);
      }
    });
  };

  useEffect(
    () => () => {
      if (frameRef.current !== 0) {
        cancelAnimationFrame(frameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const next = hexToHsv(value);
    if (next && hsvToHex(next) !== hsvToHex(hsvRef.current)) {
      hsvRef.current = next;
      setHsv(next);
    }
    setDraft(value);
  }, [value]);

  const fractionOf = (element: HTMLElement | null, event: React.PointerEvent<HTMLElement>) => {
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01(1 - (event.clientY - rect.top) / rect.height),
    };
  };

  // element 必须在事件发生时读取：首次渲染时 ref 还没挂上节点。
  const beginDrag = (element: HTMLElement | null, event: React.PointerEvent<HTMLElement>) => {
    if (!element || (event.pointerType === "mouse" && event.button !== 0)) {
      return null;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    return fractionOf(element, event);
  };

  const continueDrag = (element: HTMLElement | null, event: React.PointerEvent<HTMLElement>) => {
    if (!element || !event.currentTarget.hasPointerCapture(event.pointerId)) {
      return null;
    }
    return fractionOf(element, event);
  };

  const commitHex = (raw: string) => {
    const color = normalizeUiColor(raw);
    if (!color) {
      setDraft(value);
      return;
    }
    setDraft(color);
    const next = hexToHsv(color);
    if (next) {
      setHsv(next);
    }
    if (color !== value) {
      onChange(color);
    }
  };

  const pickFromScreen = async () => {
    const ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
    if (!ctor) {
      return;
    }
    try {
      const result = await new ctor().open();
      commitHex(result.sRGBHex);
    } catch {
      // 用户取消吸管；无需提示。
    }
  };

  const hueTrack = `linear-gradient(to right, #ff0000 0%, #ffff00 16.66%, #00ff00 33.33%, #00ffff 50%, #0000ff 66.66%, #ff00ff 83.33%, #ff0000 100%)`;
  const hex = hsvToHex(hsv);
  const hasEyeDropper = typeof window !== "undefined" && "EyeDropper" in window;

  return (
    <div className="flex flex-col gap-2.5">
      <div
        ref={areaRef}
        role="application"
        aria-label={intl.formatMessage({ id: "settings.appearance.colors.saturation" }, { name: label })}
        tabIndex={0}
        className="relative h-32 w-full cursor-crosshair touch-none overflow-hidden rounded-lg border border-border"
        style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        onPointerDown={(event) => {
          const point = beginDrag(areaRef.current, event);
          if (point) applyHsv({ ...hsvRef.current, s: point.x, v: point.y });
        }}
        onPointerMove={(event) => {
          const point = continueDrag(areaRef.current, event);
          if (point) applyHsv({ ...hsvRef.current, s: point.x, v: point.y });
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.05 : 0.01;
          const current = hsvRef.current;
          if (event.key === "ArrowLeft") applyHsv({ ...current, s: clamp01(current.s - step) });
          else if (event.key === "ArrowRight") applyHsv({ ...current, s: clamp01(current.s + step) });
          else if (event.key === "ArrowUp") applyHsv({ ...current, v: clamp01(current.v + step) });
          else if (event.key === "ArrowDown") applyHsv({ ...current, v: clamp01(current.v - step) });
          else return;
          event.preventDefault();
        }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-white to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-black to-transparent" />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: hex }}
        />
      </div>

      <div
        ref={hueRef}
        role="slider"
        aria-label={intl.formatMessage({ id: "settings.appearance.colors.hue" }, { name: label })}
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        tabIndex={0}
        className="relative h-3 w-full cursor-pointer touch-none rounded-full border border-border"
        style={{ backgroundImage: hueTrack }}
        onPointerDown={(event) => {
          const point = beginDrag(hueRef.current, event);
          if (point) applyHsv({ ...hsvRef.current, h: point.x * 360 });
        }}
        onPointerMove={(event) => {
          const point = continueDrag(hueRef.current, event);
          if (point) applyHsv({ ...hsvRef.current, h: point.x * 360 });
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 10 : 1;
          const current = hsvRef.current;
          if (event.key === "ArrowLeft") applyHsv({ ...current, h: (current.h - step + 360) % 360 });
          else if (event.key === "ArrowRight") applyHsv({ ...current, h: (current.h + step) % 360 });
          else return;
          event.preventDefault();
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.45)]"
          style={{ left: `${(hsv.h / 360) * 100}%`, backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
        />
      </div>

      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="size-7 shrink-0 rounded-md border border-border"
          style={{ backgroundColor: hex }}
        />
        <Input
          value={draft}
          size="sm"
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          aria-invalid={normalizeUiColor(draft) ? undefined : true}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => commitHex(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(value);
            }
          }}
          className="min-w-0 flex-1 font-mono"
        />
        {hasEyeDropper ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage(
              { id: "settings.appearance.colors.pickFromScreen" },
              { name: label },
            )}
            onClick={() => void pickFromScreen()}
          >
            <Pipette className="size-3.5" aria-hidden="true" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage(
            { id: "settings.appearance.colors.resetField" },
            { name: label },
          )}
          onClick={onReset}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
        </Button>
      </div>

      <div
        role="group"
        aria-label={intl.formatMessage({ id: "settings.appearance.colors.presets" })}
        className="flex flex-wrap gap-1.5"
      >
        {presets.map((preset) => (
          <button
            key={preset}
            type="button"
            aria-label={preset}
            aria-pressed={value.toLowerCase() === preset.toLowerCase()}
            onClick={() => commitHex(preset)}
            className={cn(
              "size-5 cursor-pointer rounded-full border border-border transition-shadow hover:ring-2 hover:ring-brand/40",
              value.toLowerCase() === preset.toLowerCase() &&
                "ring-2 ring-brand ring-offset-1 ring-offset-panel",
            )}
            style={{ backgroundColor: preset }}
          />
        ))}
      </div>
    </div>
  );
}
