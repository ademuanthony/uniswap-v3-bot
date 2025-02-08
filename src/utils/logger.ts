export class Logger {
  private static instance: { log: (message: string) => void };
  private static originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug
  };

  static setLogger(logger: { log: (message: string) => void }) {
    Logger.instance = logger;
    
    // Override console methods
    console.log = (...args: any[]) => {
      Logger.instance.log(args.join(' '));
    };

    console.error = (...args: any[]) => {
      Logger.instance.log(`ERROR: ${args.join(' ')}`);
    };

    console.warn = (...args: any[]) => {
      Logger.instance.log(`WARN: ${args.join(' ')}`);
    };

    console.info = (...args: any[]) => {
      Logger.instance.log(`INFO: ${args.join(' ')}`);
    };

    console.debug = (...args: any[]) => {
      Logger.instance.log(`DEBUG: ${args.join(' ')}`);
    };
  }

  static log(message: string) {
    if (Logger.instance) {
      Logger.instance.log(message);
    } else {
      Logger.originalConsole.log(message);
    }
  }

  static error(message: string, error?: any) {
    const errorMessage = error ? `${message}: ${error}` : message;
    if (Logger.instance) {
      Logger.instance.log(`ERROR: ${errorMessage}`);
    } else {
      Logger.originalConsole.error(errorMessage);
    }
  }

  // Optional: Method to restore original console behavior
  static restoreConsole() {
    console.log = Logger.originalConsole.log;
    console.error = Logger.originalConsole.error;
    console.warn = Logger.originalConsole.warn;
    console.info = Logger.originalConsole.info;
    console.debug = Logger.originalConsole.debug;
  }
} 