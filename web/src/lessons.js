// The Learn tab's course: a Beginner track, then a track for each part. The
// content is the curriculum agreed in "Let's Sing: Learn Tab Curriculum".
//
// An exercise is one of:
//   { kind: "echo", key, tonic, clef, bpm, patterns: [line …], along? }   hear a pattern, sing it back
//                                                                    (along: sing with it as it plays)
//   { kind: "tune", key, bpm, meter, voices: [{ tune, tonic, clef, ch, shift?, round? }], learn: ch, mute?: [ch] }
//   { kind: "hymn", hymn: id, part: 0-3, support: "alone" | "help" | "even" | "own", verses: "1" | "all" }
//   { kind: "range" }                                              find your range, get a part suggested
// Lines are scale degrees with lengths in eighths (see src/exercise.js).

export const TUNES = {
    "Hot Cross Buns": { meter: "4/4", notes: "2:2 1:2 0:4 2:2 1:2 0:4 0:1 0:1 0:1 0:1 1:1 1:1 1:1 1:1 2:2 1:2 0:4" },
    "Mary Had a Little Lamb": { meter: "4/4", notes: "2:2 1:2 0:2 1:2 2:2 2:2 2:4 1:2 1:2 1:4 2:2 4:2 4:4 2:2 1:2 0:2 1:2 2:2 2:2 2:2 2:2 1:2 1:2 2:2 1:2 0:8" },
    "Twinkle, Twinkle, Little Star": { meter: "4/4", notes: "0:2 0:2 4:2 4:2 5:2 5:2 4:4 3:2 3:2 2:2 2:2 1:2 1:2 0:4 4:2 4:2 3:2 3:2 2:2 2:2 1:4 4:2 4:2 3:2 3:2 2:2 2:2 1:4 0:2 0:2 4:2 4:2 5:2 5:2 4:4 3:2 3:2 2:2 2:2 1:2 1:2 0:4" },
    "Ode to Joy": { meter: "4/4", notes: "2:2 2:2 3:2 4:2 4:2 3:2 2:2 1:2 0:2 0:2 1:2 2:2 2:3 1:1 1:4 2:2 2:2 3:2 4:2 4:2 3:2 2:2 1:2 0:2 0:2 1:2 2:2 1:3 0:1 0:4" },
    "Frère Jacques": { meter: "4/4", notes: "0:2 1:2 2:2 0:2 0:2 1:2 2:2 0:2 2:2 3:2 4:4 2:2 3:2 4:4 4:1 5:1 4:1 3:1 2:2 0:2 4:1 5:1 4:1 3:1 2:2 0:2 0:2 -3:2 0:4 0:2 -3:2 0:4", entry: 16 },
    "Row, Row, Row Your Boat": { meter: "6/8", notes: "0:3 0:3 0:2 1:1 2:3 2:2 1:1 2:2 3:1 4:6 7:1 7:1 7:1 4:1 4:1 4:1 2:1 2:1 2:1 0:1 0:1 0:1 4:2 3:1 2:2 1:1 0:6", entry: 12 },
    // Under "Twinkle": the home note held, the 5th below held, and the chords' roots (do, fa, sol)
    "Twinkle drone": { meter: "4/4", notes: Array(12).fill("0:8").join(" ") },
    "Twinkle drone (5th)": { meter: "4/4", notes: Array(12).fill("-3:8").join(" ") },
    "Twinkle roots": { meter: "4/4", notes: "0:8 -4:4 0:4 -4:4 0:4 -3:4 0:4 0:4 -3:4 0:4 -3:4 0:4 -3:4 0:4 -3:4 0:8 -4:4 0:4 -4:4 0:4 -3:4 0:4" },
};

const PARTS = ["Soprano", "Alto", "Tenor", "Bass"];
const hymn = (id, part, support, verses = "1") => ({ kind: "hymn", hymn: id, part, support, verses });
const echo = (key, tonic, clef, patterns, bpm = 80) => ({ kind: "echo", key, tonic, clef, bpm, patterns });
/** A familiar tune, sung on its own with the tune playing. */
const tune = (name, key, tonic, clef, bpm = 90) => ({
    kind: "tune", title: name, key, bpm, meter: TUNES[name].meter,
    voices: [{ tune: name, tonic, clef, ch: 0 }], learn: 0,
});
/** A round: the tune and the same tune a little later; `learn` 0 sings the first entry, 1 the second. */
const round = (name, key, tonic, clef, learn, bpm = 90) => ({
    kind: "tune", title: `${name} (round)`, key, bpm, meter: TUNES[name].meter,
    voices: [{ tune: name, tonic, clef, ch: 0 }, { tune: name, tonic, clef, ch: 1, round: TUNES[name].entry }], learn,
});
/** A tune (ch 1, on top) with a line under it that the singer sings (ch 0). */
const under = (title, melody, line, key, tonic, lineTonic, clef, { shift = 0, mute = false, bpm = 90 } = {}) => ({
    kind: "tune", title, key, bpm, meter: TUNES[melody].meter,
    voices: [{ tune: melody, tonic, clef: "treble", ch: 1 }, { tune: line, tonic: lineTonic, clef, ch: 0, shift }],
    learn: 0, mute: mute ? [1] : [],
});

const BEGINNER_TARGETS = [65, 66, 67, 68, 70];
const PART_TARGETS = [70, 72, 74, 75, 77, 79, 80, 82, 84, 86, 88, 90];

export const SUPPORT = {
    alone: { name: "Alone", say: "Only your part plays" },
    help: { name: "With help", say: "All four parts; yours a little louder" },
    even: { name: "Even", say: "All four parts at the same volume" },
    own: { name: "On your own", say: "The other three play; your part is silent" },
};

const beginner = {
    id: "beginner",
    name: "Beginner",
    blurb: "Five lessons from matching one note to singing a whole hymn melody, then a range check that suggests your part.",
    lessons: [
        {
            title: "Match one note",
            tip: "Breathe low, then sing a relaxed “loo.” First, sing along with each note while it plays, sliding your voice until the circle turns green. Then hear a note and sing it back on your own. Any octave is fine: men naturally sing an octave below women.",
            exercises: [
                { title: "Sing with the note", ...echo("F", 65, "treble", ["0:8", "2:8", "1:8", "0:8"], 60), along: true },
                { title: "One note at a time", ...echo("F", 65, "treble", ["0:8", "2:8", "1:8"], 60) },
                { title: "Notes a step apart", ...echo("F", 65, "treble", ["0:8", "1:8", "2:8", "1:8"], 60) },
            ],
        },
        {
            title: "Steps",
            tip: "Most melodies move by steps, like a staircase: next door up or next door down. Listen to the whole pattern before you sing it back.",
            exercises: [
                { title: "Step patterns", ...echo("F", 65, "treble", ["0:2 1:2 2:4", "2:2 1:2 0:4", "0:2 1:2 2:2 1:2 0:4"]) },
                tune("Hot Cross Buns", "F", 65, "treble", 80),
            ],
        },
        {
            title: "Skips",
            tip: "A skip jumps over a note, like do-mi-sol. Hear the landing note in your head before you jump to it.",
            exercises: [
                { title: "Skip patterns", ...echo("F", 65, "treble", ["0:2 2:4", "0:2 2:2 4:4", "4:2 2:2 0:4", "0:2 4:4"]) },
                tune("Mary Had a Little Lamb", "G", 67, "treble"),
                tune("Twinkle, Twinkle, Little Star", "C", 60, "treble"),
            ],
        },
        {
            title: "Follow a melody",
            tip: "Keep the sound steady through long notes. If you miss a note, keep going: the next note is a new chance.",
            exercises: [
                tune("Ode to Joy", "C", 60, "treble"),
                tune("Frère Jacques", "F", 65, "treble"),
                hymn(328, 0, "alone"),
            ],
        },
        {
            title: "Your first hymn",
            tip: "A hymn is the same skill, a little longer. Sing verse 1 with the melody playing. Then find your range, so the app can suggest which part to learn next.",
            exercises: [hymn(22, 0, "alone"), hymn(248, 0, "alone"), { kind: "range", title: "Find your range" }],
        },
    ],
};

const soprano = {
    id: "soprano",
    name: "Soprano",
    part: 0,
    blurb: "The melody: a clean top range, steady pitch over long phrases, and carrying the tune on your own.",
    lessons: [
        { title: "Where the soprano sits", tip: "The soprano part sits from about middle C to F5. Sing lightly: height comes from space, not pushing.",
          exercises: [{ title: "Patterns up to C5", ...echo("C", 60, "treble", ["0:2 2:2 4:4", "4:2 5:2 7:4", "7:2 4:2 2:2 0:4"]) },
                      { title: "Patterns up to D5", ...echo("C", 60, "treble", ["2:2 4:2 7:4", "7:2 8:2 7:4", "8:2 7:2 4:4"]) }] },
        { title: "Higher without strain", tip: "Drop the jaw and keep the sound in front as you climb. If a note pinches, go back down and try it again, softer.",
          exercises: [{ title: "Scales up to D5", ...echo("G", 67, "treble", ["0:2 1:2 2:2 3:2 4:4", "4:2 3:2 2:2 1:2 0:4"]) },
                      { title: "Scales up to F5", ...echo("Bb", 70, "treble", ["0:2 1:2 2:2 3:2 4:4", "4:2 3:2 2:2 1:2 0:4"]) },
                      tune("Ode to Joy", "G", 67, "treble")] },
        { title: "Your first hymn melody", tip: "Short hymns that move by small steps make the best first hymns.",
          exercises: [hymn(328, 0, "alone"), hymn(43, 0, "alone")] },
        { title: "Leaps in a melody", tip: "Melodies often leap up a 4th or 5th at the start of a line. Hear the top note before you leave the bottom one.",
          exercises: [hymn(22, 0, "alone"), hymn(248, 0, "alone")] },
        { title: "A round", tip: "In a round, someone else sings your tune a little behind you. Listen to them, but keep your own place.",
          exercises: [round("Frère Jacques", "F", 65, "treble", 0), round("Row, Row, Row Your Boat", "F", 65, "treble", 0)] },
        { title: "Melody over a second part", tip: "The alto often moves a 3rd under you. Let it ring with you rather than pull you down.",
          exercises: [{ ...under("Mary Had a Little Lamb, with an alto", "Mary Had a Little Lamb", "Mary Had a Little Lamb", "G", 67, 67, "treble", { shift: -2 }), learn: 1 },
                      hymn(162, 0, "help")] },
        { title: "Reading your line", tip: "Soprano is the top staff, stems up. Watch whether the next note goes up or down, and how far.",
          exercises: [hymn(161, 0, "help"), hymn(36, 0, "even")] },
        { title: "Long phrases", tip: "Breathe at the commas, not in the middle of a word. Plan where each breath goes in the first verse.",
          exercises: [hymn(216, 0, "even"), hymn(155, 0, "even")] },
        { title: "Steady in full harmony", tip: "With all four parts sounding, listen for your note sitting at the top of the chord.",
          exercises: [hymn(491, 0, "even"), hymn(114, 0, "even")] },
        { title: "Dotted rhythms", tip: "A dotted note is long-short. Hold the long one its full length, and don't rush the short one.",
          exercises: [hymn(59, 0, "even"), hymn(143, 0, "even")] },
        { title: "Wide range", tip: "These hymns span more than an octave. Set the low notes gently so the high ones have room.",
          exercises: [hymn(37, 0, "even"), hymn(264, 0, "even"), hymn(66, 0, "even")] },
        { title: "On your own", tip: "Your part is silent: you carry the tune for everyone. Sing every verse.",
          exercises: [hymn(5, 0, "own", "all"), hymn(10, 0, "own", "all"), hymn(212, 0, "own", "all")] },
    ],
};

const alto = {
    id: "alto",
    name: "Alto",
    part: 1,
    blurb: "Just under the melody: repeated notes, 3rds below the tune, and lines that go their own way.",
    lessons: [
        { title: "Where the alto sits", tip: "The alto part sits from about G3 to C5, and often stays on one note while the tune moves.",
          exercises: [{ title: "Patterns with repeated notes", ...echo("C", 60, "treble", ["0:2 0:2 0:4", "-3:2 -3:2 0:4", "2:2 2:2 1:2 0:2", "4:2 4:2 4:2 2:2"]) }] },
        { title: "Holding under a tune", tip: "Hold your note while the melody moves above you. Listen to it, but stay put.",
          exercises: [under("Hold the home note under “Twinkle”", "Twinkle, Twinkle, Little Star", "Twinkle drone", "F", 65, 65, "treble"),
                      under("Hold the 5th under “Twinkle”", "Twinkle, Twinkle, Little Star", "Twinkle drone (5th)", "F", 65, 65, "treble")] },
        { title: "Singing in 3rds", tip: "Altos often sing a 3rd under the melody, moving the same way it does.",
          exercises: [under("“Mary” in 3rds, alone", "Mary Had a Little Lamb", "Mary Had a Little Lamb", "G", 67, 67, "treble", { shift: -2, mute: true }),
                      under("“Mary” in 3rds, with the tune", "Mary Had a Little Lamb", "Mary Had a Little Lamb", "G", 67, 67, "treble", { shift: -2 })] },
        { title: "Your first alto line", tip: "Start with alto lines that barely move.",
          exercises: [hymn(230, 1, "alone"), hymn(328, 1, "alone")] },
        { title: "A round", tip: "Come in on your own entry and keep going while the tune sounds a bar ahead of you.",
          exercises: [round("Row, Row, Row Your Boat", "F", 65, "treble", 1), hymn(257, 1, "help")] },
        { title: "Reading your line", tip: "Alto is the top staff, stems down. Where two notes share a stem, yours is the lower one.",
          exercises: [hymn(154, 1, "help"), hymn(160, 1, "help")] },
        { title: "Close harmony", tip: "When you are a 3rd under the tune, the two notes should blend into one sound.",
          exercises: [hymn(162, 1, "even"), hymn(255, 1, "even")] },
        { title: "Staying put", tip: "Long repeated notes tend to drift flat. Lift slightly on each repeat.",
          exercises: [hymn(9, 1, "help"), hymn(230, 1, "even")] },
        { title: "Full harmony", tip: "You are the middle of the chord. Listen down to the bass as well as up to the tune.",
          exercises: [hymn(22, 1, "even"), hymn(36, 1, "even")] },
        { title: "Your own path", tip: "In these hymns the alto moves the same way as the tune less than 40% of the time.",
          exercises: [hymn(248, 1, "even"), hymn(327, 1, "even")] },
        { title: "Against the melody", tip: "When the tune goes up and you go down, trust the score and your ear for the chord.",
          exercises: [hymn(78, 1, "even"), hymn(114, 1, "even")] },
        { title: "On your own", tip: "Your part is silent; the other three play. Sing every verse.",
          exercises: [hymn(59, 1, "own", "all"), hymn(229, 1, "own", "all"), hymn(37, 1, "own", "all")] },
    ],
};

const tenor = {
    id: "tenor",
    name: "Tenor",
    part: 2,
    blurb: "Men's higher voices, at the top of the lower staff: from the tune an octave down to true tenor lines.",
    lessons: [
        { title: "Where the tenor sits", tip: "The tenor part sits from about C3 to G4. Keep the high notes light and forward; don't shout them.",
          exercises: [{ title: "Patterns up to C4", ...echo("C", 48, "treble-8", ["0:2 2:2 4:4", "4:2 5:2 7:4", "7:2 4:2 2:2 0:4"]) },
                      { title: "Patterns up to E4", ...echo("C", 48, "treble-8", ["4:2 7:2 9:4", "9:2 8:2 7:4", "7:2 8:2 9:2 7:2 4:4"]) }] },
        { title: "The tune in your range", tip: "Singing the melody an octave low is a real part: it is what most men do in church.",
          exercises: [tune("Twinkle, Twinkle, Little Star", "C", 48, "treble-8"), tune("Ode to Joy", "D", 50, "treble-8")] },
        { title: "The tenor sings the tune", tip: "In Tallis' Canon the tenor sings the melody, starting a line after the sopranos.",
          exercises: [hymn(17, 2, "alone")] },
        { title: "Your first tenor line", tip: "Start with tenor lines that barely move.",
          exercises: [hymn(230, 2, "alone"), hymn(328, 2, "alone")] },
        { title: "Canon and round", tip: "Keep your entry while the others sing the same tune ahead of you.",
          exercises: [round("Frère Jacques", "F", 53, "treble-8", 1), hymn(17, 2, "help")] },
        { title: "Close to the tune", tip: "These tenor lines move the same way as the melody about three times in four.",
          exercises: [hymn(200, 2, "help"), hymn(565, 2, "help")] },
        { title: "Reading bass clef", tip: "Tenor is the lower staff, stems up. Bass-clef lines and spaces differ from treble: the lines from the bottom are G, B, D, F, A.",
          exercises: [hymn(207, 2, "even"), hymn(491, 2, "even")] },
        { title: "Steady notes", tip: "Narrow tenor lines repeat notes. Keep them from sagging.",
          exercises: [hymn(36, 2, "even"), hymn(510, 2, "even")] },
        { title: "Full harmony", tip: "You sit between the alto and the bass. Hear the chord, not just the tune.",
          exercises: [hymn(248, 2, "even"), hymn(22, 2, "even")] },
        { title: "Wider lines", tip: "These tenor lines span an octave. Prepare the top notes with space, not force.",
          exercises: [hymn(13, 2, "even"), hymn(327, 2, "even")] },
        { title: "Against the melody", tip: "These tenor lines move with the tune less than a third of the time.",
          exercises: [hymn(114, 2, "even"), hymn(255, 2, "even"), hymn(78, 2, "even")] },
        { title: "On your own", tip: "Your part is silent; the other three play. Sing every verse.",
          exercises: [hymn(5, 2, "own", "all"), hymn(284, 2, "own", "all"), hymn(264, 2, "own", "all")] },
    ],
};

const bass = {
    id: "bass",
    name: "Bass",
    part: 3,
    blurb: "The foundation: the lowest note of each chord, with the 4ths, 5ths and octaves other parts rarely sing.",
    lessons: [
        { title: "Where the bass sits", tip: "The bass part sits from about F2 to C4. Relax your throat on low notes; don't press down for them.",
          exercises: [{ title: "Patterns from G2 to C4", ...echo("C", 48, "bass", ["0:2 0:2 0:4", "-3:2 -2:2 -1:2 0:2", "0:2 2:2 4:4", "4:2 5:2 7:4", "7:2 4:2 0:4"]) }] },
        { title: "Home and the 5th", tip: "Most bass lines lean on the home note and the note a 5th above it.",
          exercises: [{ title: "Leaps of a 5th and an octave", ...echo("C", 48, "bass", ["0:2 4:4", "4:2 0:4", "0:2 7:4", "7:2 0:4", "0:2 -3:4", "-3:2 0:4"]) }] },
        { title: "Roots under a tune", tip: "The bass sings the root of each chord under the melody: here do, fa and sol.",
          exercises: [under("Roots of “Twinkle”, alone", "Twinkle, Twinkle, Little Star", "Twinkle roots", "C", 60, 48, "bass", { mute: true }),
                      under("Roots of “Twinkle”, with the tune", "Twinkle, Twinkle, Little Star", "Twinkle roots", "C", 60, 48, "bass")] },
        { title: "Your first bass line", tip: "Start with bass lines that move by step.",
          exercises: [hymn(326, 3, "alone"), hymn(257, 3, "alone")] },
        { title: "A round, low", tip: "Take your entry in a round under the others, and keep your place.",
          exercises: [round("Row, Row, Row Your Boat", "G", 43, "bass", 1), hymn(329, 3, "help")] },
        { title: "Reading your line", tip: "Bass is the lower staff, stems down. At the end of a line, look for the leap to the home note.",
          exercises: [hymn(328, 3, "help"), hymn(565, 3, "help")] },
        { title: "Bass with the tune", tip: "These bass lines move with the melody more than most bass lines do.",
          exercises: [hymn(155, 3, "even"), hymn(162, 3, "even")] },
        { title: "Octave leaps", tip: "Land an octave leap by hearing the same note, higher or lower.",
          exercises: [hymn(248, 3, "even"), hymn(22, 3, "even")] },
        { title: "Full harmony", tip: "You hold up the chord. Sing steadily and the other parts tune to you.",
          exercises: [hymn(161, 3, "even"), hymn(9, 3, "even")] },
        { title: "Independent lines", tip: "These bass lines move with the tune less than 40% of the time.",
          exercises: [hymn(114, 3, "even"), hymn(143, 3, "even")] },
        { title: "Wide range", tip: "These bass lines span 17 semitones. Keep the low notes free and the high ones light.",
          exercises: [hymn(36, 3, "even"), hymn(95, 3, "even")] },
        { title: "On your own", tip: "Your part is silent; the other three play. Sing every verse.",
          exercises: [hymn(10, 3, "own", "all"), hymn(488, 3, "own", "all"), hymn(6, 3, "own", "all")] },
    ],
};

export const TRACKS = [beginner, soprano, alto, tenor, bass];
for (const t of TRACKS) {
    const targets = t.id === "beginner" ? BEGINNER_TARGETS : PART_TARGETS;
    t.lessons.forEach((l, i) => (l.target = targets[i]));
}

export const trackById = (id) => TRACKS.find((t) => t.id === id);
export { PARTS };
