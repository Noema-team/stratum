import type { ExecutionAdapter, ExecutorCapability } from './types.js';

export class ExecutorRegistry {
  private readonly adapters = new Map<string, ExecutionAdapter>();

  register(adapter: ExecutionAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  findById(id: string): ExecutionAdapter | undefined {
    return this.adapters.get(id);
  }

  // Returns the first registered adapter that has ALL of the required capabilities.
  findByCapabilities(required: ReadonlySet<ExecutorCapability>): ExecutionAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      const caps = adapter.getCapabilities();
      let match = true;
      for (const cap of required) {
        if (!caps.has(cap)) { match = false; break; }
      }
      if (match) return adapter;
    }
    return undefined;
  }

  list(): ExecutionAdapter[] {
    return [...this.adapters.values()];
  }
}
