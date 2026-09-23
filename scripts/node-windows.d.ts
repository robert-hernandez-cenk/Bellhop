declare module 'node-windows' {
  interface ServiceEnvVar {
    name: string;
    value: string;
  }

  interface ServiceOptions {
    name: string;
    description?: string;
    script: string;
    nodeOptions?: string[];
    env?: ServiceEnvVar | ServiceEnvVar[];
    workingDirectory?: string;
    wait?: number;
    grow?: number;
    maxRetries?: number;
    maxRestarts?: number;
    abortOnError?: boolean;
  }

  type ServiceEvent =
    | 'install'
    | 'alreadyinstalled'
    | 'invalidinstallation'
    | 'uninstall'
    | 'alreadyuninstalled'
    | 'start'
    | 'stop'
    | 'error';

  class Service {
    exists: boolean;
    constructor(options: ServiceOptions);
    install(): void;
    uninstall(): void;
    start(): void;
    stop(): void;
    on(event: ServiceEvent, listener: (...args: unknown[]) => void): void;
  }

  interface NodeWindows {
    Service: typeof Service;
    elevate(
      cmd: string,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ): void;
  }

  const nodeWindows: NodeWindows;
  export = nodeWindows;
}
