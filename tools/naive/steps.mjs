// What a player does on each map, as checkpoints (actor names in the map). Routes between them are
// planned from the level geometry and walked with key/mouse input.
export const CHAIN = 'Lev_Tut1,Lev_Tut1b,Lev_Tut2,Lev_Tut3,Lev_Tut3b,Lev2_HogFront,Lev2_Inc_A,Lev2_Inc_B,Lev2_HogFront_2,Lev2_RemChase,Lev2_HogFront_3,Lev2_Fire2,Lev2_fire1,Lev2_Quid1,Lev3_Intro,Lev3_Lumos,Lev3_PreDungeon,Lev3_Dungeon,Lev3_DungeonB,Lev3_PreTroll,Lev3_Troll,Lev3_Quid2,Lev4_Sneak,Lev4_Sneak2,Lev5_Fluffy,Lev5_Snare,Lev5_FlyKeys,Lev5_Chess,Lev5_Final,Snapes_Office,startup'.split(',');

export const STEPS = {
  lev_tut1: [
    { go: 'CutScene52' },                 // twins' corridor
    { go: 'CutScene54' },                 // climbing lesson room
    { go: 'Trigger19' },
    { go: 'CutScene55' },                 // across the jumping course
    { beans: 25 },                        // Fred sells the wizard card for 25 beans
    { bump: 'Tut1Fred3' },                // buying it opens the secret door (FGsec2)
    { go: 'CutScene56' },
    { go: 'CutScene1' },
    { go: 'CutScene58' },
    { go: 'CutScene59' },
    { lesson: 'SpellLearnTrigger0' },     // Flipendo lesson, traced with the mouse
  ],
  lev_tut1b: [
    // (the switch/door course before it isn't solved by the bot: teleport into the gnome room)
    { tp: 'Trigger2', dx: 60, yaw: 32768 },  // walking on into Trigger2/29 launches the gnomes
    { go: 'Trigger29', radius: 40 },
    { stun: ['Tut1Gnome0', 'tut1gnome1', 'tut1gnome2'] }, // Flipendo each until stunned: CounterGnome -> ExitFlip opens the doors
    { go: 'StarsTrigger0', radius: 60 },   // the stars count picks the ending cutscene -> ChangeLevel Lev_Tut2
  ],
};
