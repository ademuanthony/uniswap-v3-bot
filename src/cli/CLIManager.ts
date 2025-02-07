import * as blessed from 'blessed';
import { StrategyExecutor } from '../types/Strategy';
import { Contract, Wallet } from 'ethers';

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

  public registerStrategy(strategy: StrategyExecutor): void {
    this.strategies.set(strategy.getName(), strategy);
    this.updateStrategyState(strategy.getName(), {
      name: strategy.getName(),
      status: strategy.isRunning() ? 'Running' : 'Stopped',
      lastUpdate: new Date().toISOString(),
    });
  }

  public log(message: string): void {
    this.logPanel.log(`[${new Date().toISOString()}] ${message}`);
    this.screen.render();
  }

  public updateStrategyState(
    strategyName: string,
    state: Partial<StrategyState>
  ): void {
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

    this.updateStatePanel();
  }

  private updateStatePanel(): void {
    let content = '';
    for (const state of this.strategyStates.values()) {
      content += `{bold}${state.name}{/bold}\n`;
      content += `Status: ${state.status}\n`;

      if (state.positions && state.positions.length > 0) {
        content += 'Positions:\n';
        state.positions.forEach((pos: any) => {
          const posStr = Object.entries(pos)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');
          content += `  - ${posStr}\n`;
        });
      }

      content += `Last Update: ${state.lastUpdate}\n\n`;
    }

    this.statePanel.setContent(content);
    this.screen.render();
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
    const [action, strategyName, ...args] = command.trim().split(' ');

    if (!action) return;

    const strategy = this.strategies.get(strategyName);
    if (!strategy && action !== 'help' && action !== 'quit') {
      this.log(`Strategy not found: ${strategyName}`);
      return;
    }

    try {
      switch (action.toLowerCase()) {
        case 'help':
          this.log('Available commands:');
          this.log('  start <strategy>  - Start a strategy');
          this.log('  stop <strategy>   - Stop a strategy');
          this.log('  status <strategy> - Get strategy status');
          this.log('  quit              - Shutdown bot');
          this.log('  help              - Show this help');
          break;

        case 'quit':
          await this.shutdown();
          break;

        case 'start':
          if (!strategy) break;
          // await strategy.start(this.router, this.wallet);
          this.log(`Started strategy: ${strategyName}`);
          this.updateStrategyState(strategyName, { status: 'Running' });
          break;

        case 'stop':
          if (!strategy) break;
          strategy.stop();
          this.log(`Stopped strategy: ${strategyName}`);
          this.updateStrategyState(strategyName, { status: 'Stopped' });
          break;

        case 'status':
          if (!strategy) break;
          const status = await strategy.getStatus();
          this.log(`Status for ${strategyName}:`);
          this.log(JSON.stringify(status, null, 2));
          break;

        default:
          this.log(`Unknown command: ${action}`);
          this.log('Type "help" for available commands');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      this.log(`Error executing command: ${errorMessage}`);
    }
  }
}
