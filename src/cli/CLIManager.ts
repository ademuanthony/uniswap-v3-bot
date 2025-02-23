import * as blessed from 'blessed';
import { StrategyExecutor } from '../types/Strategy';

interface StrategyState {
  name: string;
  status: string;
  positions?: any[];
  lastUpdate: string;
}

export class CLIManager {
  private screen: blessed.Widgets.Screen;
  private logPanel: blessed.Widgets.Log;
  private statePanel: blessed.Widgets.BoxElement;
  private inputPanel: blessed.Widgets.TextboxElement;
  private strategies: Map<string, StrategyExecutor> = new Map();
  private strategyStates: Map<string, StrategyState> = new Map();

  constructor() {
    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Trading Bot CLI',
      cursor: {
        artificial: true,
        shape: 'line',
        blink: true,
        color: 'default',
      },
      terminal: 'xterm',
      fullUnicode: true,
      dockBorders: true,
      ignoreLocked: ['C-c'],
    });

    // Create log panel (right side)
    this.logPanel = blessed.log({
      parent: this.screen,
      right: 0,
      top: 0,
      width: '60%',
      height: '90%',
      border: { type: 'line' },
      label: ' Logs ',
      tags: true,
      keys: true,
      vi: true,
      clickable: true,
      mouse: true,
      scrollback: 100,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'cyan',
        },
        style: {
          inverse: true,
        },
      },
    });

    // Create state panel (left side)
    this.statePanel = blessed.box({
      parent: this.screen,
      left: 0,
      top: 0,
      width: '40%',
      height: '90%',
      border: { type: 'line' },
      label: ' Strategy States ',
      tags: true,
      scrollable: true,
      mouse: true,
      scrollbar: {
        ch: ' ',
        track: {
          bg: 'cyan',
        },
      },
    });

    // Create input panel (bottom)
    this.inputPanel = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: '10%',
      border: { type: 'line' },
      label: ' Command Input ',
      keys: true,
      mouse: true,
      inputOnFocus: true,
      style: {
        focus: {
          border: {
            fg: 'green',
          },
        },
      },
    });

    // Handle input
    this.inputPanel.key(['enter'], async () => {
      const command = this.inputPanel.getValue();
      this.inputPanel.clearValue();
      this.inputPanel.focus();
      await this.handleCommand(command);
      this.screen.render();
    });

    // Focus input on start
    this.inputPanel.focus();

    // Quit on Ctrl-C or q
    this.screen.key(['C-c', 'q'], async () => {
      await this.shutdown();
    });

    // Initial render
    this.screen.render();
  }

  public async registerStrategy(strategy: StrategyExecutor): Promise<void> {
    const key = strategy.getKey();
    this.strategies.set(key, strategy);
    await this.updateStrategyState(key, {
      name: strategy.getName(),
      status: strategy.isRunning() ? 'Running' : 'Stopped',
      lastUpdate: new Date().toISOString(),
    });
  }

  public log(message: string): void {
    this.logPanel.log(`[${new Date().toISOString()}] ${message}`);
    this.screen.render();
  }

  public async updateStrategyState(
    strategyName: string,
    state: Partial<StrategyState>
  ): Promise<void> {
    const currentState = this.strategyStates.get(strategyName) || {
      name: strategyName,
      status: 'Unknown',
      lastUpdate: new Date().toISOString(),
    };

    this.strategyStates.set(strategyName, {
      ...currentState,
      ...state,
      lastUpdate: new Date().toISOString(),
    });

    await this.updateStatePanel();
  }

  private async updateStatePanel(): Promise<void> {
    try {
      let content = '';
      for (const [key, strategy] of this.strategies) {
        const state = this.strategyStates.get(key);
        if (!state) continue;

        content += `${state.name}\n`;
        content += `Key: ${key}\n`;
        content += `Status: ${state.status}\n`;

        try {
          if (!strategy.isRunning()) {
            if (content.length > 0) {
              content += `Run '${key} start' to start the strategy\n\n`;
            }
            continue;
          }
          const displayInfo = await strategy.getDisplayInfo();
          for (const line of displayInfo) {
            content += `${line}\n`;
          }
        } catch (error) {
          this.log(`Error getting display info for ${state.name}: ${error}`);
        }

        content += `Last Update: ${state.lastUpdate}\n\n`;
      }

      this.statePanel.setContent(content);
      this.screen.render();
    } catch (error) {
      this.log(`Error updating state panel: ${error}`);
    }
  }

  private async shutdown(): Promise<void> {
    this.log('Shutting down bot...');

    // Stop all running strategies
    for (const [name, strategy] of this.strategies) {
      try {
        if (strategy.isRunning()) {
          strategy.stop();
          this.log(`Stopped strategy: ${name}`);
        }
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        this.log(`Error stopping strategy ${name}: ${errorMessage}`);
      }
    }

    this.log('Shutdown complete');
    process.exit(0);
  }

  private async handleCommand(command: string): Promise<void> {
    const [strategyKey, action, ...args] = command.trim().split(' ');

    if (!strategyKey) return;

    if (strategyKey === 'help') {
      this.log('Command format: <strategy> <command> [args]');
      this.log('Available commands:');
      this.log('  <strategy> start        - Start a strategy');
      this.log('  <strategy> stop         - Stop a strategy');
      this.log('  <strategy> status       - Get strategy status');
      this.log('  <strategy> <command>    - Execute strategy-specific command');
      this.log('  <strategy> help         - Show strategy-specific help');
      this.log('  start                   - Start all strategies');
      this.log('  stop                    - Stop all strategies');
      this.log('  quit                    - Shutdown bot');
      this.log('  help                    - Show this help');
      return;
    }

    if (strategyKey === 'quit') {
      await this.shutdown();
      return;
    }

    if (strategyKey === 'start') {
      for (const [name, strategy] of this.strategies) {
        if (strategy.isRunning()) {
          this.log(`Strategy ${name} is already running`);
          continue;
        }

        (async () => {
          try {
            this.log(`Starting strategy: ${name}`);
            await strategy.start();
          } catch (error: unknown) {
            const errorMessage =
              error instanceof Error ? error.message : 'Unknown error';
            this.log(`Error starting strategy ${name}: ${errorMessage}`);
          }
        })();
      }
      return;
    }

    if (strategyKey === 'stop') {
      for (const [name, strategy] of this.strategies) {
        if (!strategy.isRunning()) {
          this.log(`Strategy ${name} is not running`);
          continue;
        }
        try {
          console.log('Stopping strategy:', name);
          strategy.stop();
          this.log(`Stopped strategy: ${name}`);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          this.log(`Error stopping strategy ${name}: ${errorMessage}`);
        }
      }
      return;
    }

    const strategy = this.strategies.get(strategyKey);
    if (!strategy) {
      this.log(`Strategy not found: ${strategyKey}`);
      return;
    }

    try {
      switch (action?.toLowerCase()) {
        case 'start':
          await strategy.start();
          this.log(`Started strategy: ${strategyKey}`);
          await this.updateStrategyState(strategyKey, { status: 'Running' });
          break;

        case 'stop':
          strategy.stop();
          this.log(`Stopped strategy: ${strategyKey}`);
          await this.updateStrategyState(strategyKey, { status: 'Stopped' });
          break;

        case 'status':
          const status = await strategy.getStatus();
          this.log(`Status for ${strategyKey}:`);
          this.log(JSON.stringify(status, null, 2));
          break;

        default:
          // Forward unknown commands to strategy
          if (action) {
            const response = await strategy.handleCommand(action, args);
            this.log(response);
          } else {
            this.log('No command specified');
            this.log('Type "help" for available commands');
          }
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error executing command: ${errorMessage}`);
    }
  }
}
