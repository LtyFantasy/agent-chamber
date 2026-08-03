'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** 乱码字符池：黑客解码风的符号 + 字母数字 */
const GLYPHS = '!<>-_\\/[]{}=+*^?#@%&01ABCDEF';

interface ScrambleTextProps {
  text: string;
  className?: string;
  /** 两次乱码突发的间隔（默认 6s） */
  intervalMs?: number;
  /** 单次乱码→归位时长（默认 900ms） */
  durationMs?: number;
}

/**
 * 乱码解码文字：周期性把文本打散成随机字符，再从左到右逐字归位。
 * 突发期间挂 .glitching（色散加重，无位移抖动），平时是 .glitch-soft 的轻微故障色差；
 * 两类都含青光发光（合并 text-glow-cyan 的 text-shadow，单属性后写会覆盖）。
 * prefers-reduced-motion 时退化为纯静态文本（动效红线，与 use-tilt 同一守卫）。
 */
export function ScrambleText({
  text,
  className,
  intervalMs = 6000,
  durationMs = 900,
}: ScrambleTextProps) {
  const [display, setDisplay] = useState(text);
  const [glitching, setGlitching] = useState(false);
  const rafRef = useRef<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const run = () => {
      const start = performance.now();
      setGlitching(true);
      const tick = (now: number) => {
        const progress = Math.min((now - start) / durationMs, 1);
        // 左 → 右逐字归位：已归位段用原文，未归位段随机字符
        const settledCount = Math.floor(progress * (text.length + 1));
        let out = text.slice(0, settledCount);
        for (let i = settledCount; i < text.length; i++) {
          out += GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
        setDisplay(out);
        if (progress < 1) {
          rafRef.current = requestAnimationFrame(tick);
        } else {
          setDisplay(text);
          setGlitching(false);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    // 首次进页面 1.5s 后先来一次，之后按 intervalMs 周期突发
    const first = setTimeout(() => {
      run();
      intervalRef.current = setInterval(run, intervalMs);
    }, 1500);

    return () => {
      clearTimeout(first);
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [text, intervalMs, durationMs]);

  return (
    <span aria-label={text} className={cn(className, glitching && 'glitching')}>
      {display}
    </span>
  );
}
