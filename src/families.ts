/** Where in the game something happened (death, damage, economy, items, performance, errors). */
export interface Place {
  world?: string;
  level?: string;
}

/**
 * The ready-made event families and their fields, as the server checks them. An app adds
 * its own fields to a family through an extension schema (`ext`) and makes its own event types.
 */
export interface FamilyData {
  screen_view: { screen: string; previous?: string };
  button: { name: string; screen?: string };
  tutorial: { tutorial: string; step: number; action: 'start' | 'complete' | 'skip' };
  progression: {
    action: 'start' | 'complete' | 'fail' | 'quit' | 'checkpoint' | 'restart';
    level: string;
    world?: string;
    part?: string;
    checkpoint?: string;
    attempt?: number;
    seconds?: number;
    activeSeconds?: number;
    deaths?: number;
    score?: number;
  };
  death: Place & { cause: string; enemy?: string };
  damage: Place & { amount: number; source?: string };
  position_sample: Place & { seconds: number };
  economy: Place & { direction: 'earn' | 'spend'; currency: string; amount: number; source?: string; sink?: string; item?: string };
  balance: { currency: string; amount: number };
  item: Place & { action: 'pickup' | 'use' | 'equip' | 'unequip' | 'drop' | 'craft' | 'buy' | 'sell'; item: string; count?: number };
  interaction: Place & { kind: 'dialog' | 'puzzle' | 'secret' | 'hint' | 'npc' | 'other'; name: string; choice?: string; outcome?: string };
  performance: Place & {
    fps?: number;
    fpsLow1?: number;
    frameMs?: number;
    loadMs?: number;
    loadKind?: 'startup' | 'level' | 'other';
    memoryMb?: number;
    batteryPct?: number;
    thermal?: 'nominal' | 'fair' | 'serious' | 'critical';
    latencyMs?: number;
  };
  settings: {
    graphicsPreset?: string;
    resolution?: string;
    language?: string;
    subtitles?: boolean;
    subtitleLanguage?: string;
    difficulty?: string;
    inputDevice?: 'keyboard_mouse' | 'gamepad' | 'touch' | 'other';
  };
  error: Place & { kind: 'exception' | 'crash' | 'assert' | 'other'; message?: string; fingerprint?: string; handled?: boolean };
}

export type Family = keyof FamilyData;
