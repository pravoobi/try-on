import { config } from '../config';
import type { Accelerator } from '@practics/tryon-core';

interface Timings {
  segmentMs: number;
  poseMs: number;
}

interface Props {
  accelerator: Accelerator;
  onAcceleratorChange: (a: Accelerator) => void;
  /** Backend actually in use once the pipeline is ready (may differ from `accelerator` after a fallback). */
  backend: Accelerator | null;
  fps: number | null;
  timings: Timings | null;
}

function StatTile({ label, value, status }: { label: string; value: string; status?: 'good' | 'warn' }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {status && <span className={`status-dot ${status}`} />}
        {value}
      </span>
    </div>
  );
}

/**
 * The WebGPU/CPU toggle + live perf readout — CLAUDE.md Phase 4 calls this
 * out explicitly as a demo talking point (show the on-device GPU speedup).
 */
export function PerfStats({ accelerator, onAcceleratorChange, backend, fps, timings }: Props) {
  const backendIsGpu = backend === 'webgpu';
  return (
    <div className="perf-stats">
      <div className="segmented" role="group" aria-label="accelerator">
        <button
          className={accelerator === 'webgpu' ? 'selected' : ''}
          onClick={() => onAcceleratorChange('webgpu')}
        >
          WebGPU
        </button>
        <button
          className={accelerator === 'wasm' ? 'selected' : ''}
          onClick={() => onAcceleratorChange('wasm')}
        >
          CPU (wasm)
        </button>
      </div>

      {backend && (
        <StatTile
          label="backend"
          value={backendIsGpu ? 'WebGPU' : 'CPU'}
          status={backendIsGpu ? 'good' : 'warn'}
        />
      )}
      {fps !== null && (
        <StatTile
          label="fps"
          value={fps.toFixed(1)}
          status={fps >= config.targetFps * 0.7 ? 'good' : 'warn'}
        />
      )}
      {timings && <StatTile label="segment" value={`${timings.segmentMs.toFixed(1)} ms`} />}
      {timings && <StatTile label="pose" value={`${timings.poseMs.toFixed(1)} ms`} />}
    </div>
  );
}
