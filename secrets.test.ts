// Secrets, in a Pi Pocket of its own: a temporary data folder, a scripted model, the module in the drop-in folder.
// Run with POCKET_DIR set to a Pi Pocket 0.22.0 (or later) checkout with its packages installed:
//   POCKET_DIR=~/work/pi-pocket node --test secrets.test.ts
import assert from "node:assert/strict";
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

const POCKET = resolve(process.env.POCKET_DIR ?? "../pi-pocket");
// Pi Pocket's test helpers first: they point Pi Pocket at a temporary folder before it loads.
const helpers = await import(join(POCKET, "test", "helpers.ts"));
const {
    cleanUp,
    lastText,
    modelTexts,
    newSession,
    openApp,
    owner,
    root,
    say,
    scriptedModel,
    until,
    work,
} = helpers;
const { fauxAssistantMessage, fauxText, fauxToolCall } = await import(
    join(POCKET, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js")
);
const { createHandler } = await import(join(POCKET, "src", "server", "http.ts"));

type App = Awaited<ReturnType<typeof openApp>>;
type Id = Awaited<ReturnType<typeof newSession>>;

const TOKEN = "s3cr3t+token/value=x";
const ASKED = "asked-first-value-1234";
const GUESTS = "guests-may-use-this-9876";
const FOLDERED = "only-in-work-acme-5555";
/** Everything the model was sent: no value may be in it. */
const sent: string[] = [];

const call = (name: string, args: Record<string, unknown>) =>
    fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const model = scriptedModel((request: { messages: unknown[] }) => {
    sent.push(JSON.stringify(request));
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    const bash = (command: string) => call("bash", { command });

    if (text.endsWith("use the token")) {
        return bash(`printf '%s' "$TOKEN" | wc -c; printf 'v=%s\\n' "$TOKEN"`);
    }

    if (text.endsWith("encode the token")) {
        return bash(
            `printf '%s' "$TOKEN" | base64; node -e 'console.log(encodeURIComponent(process.env.TOKEN))'`,
        );
    }

    if (text.endsWith("use the asked one")) {
        return bash(`printf '%s' "$ASKED" | wc -c`);
    }

    if (text.endsWith("use the guests one")) {
        return bash(`printf '%s' "$GUESTS" | wc -c`);
    }

    if (text.endsWith("use the foldered one")) {
        return bash(`printf '%s' "$FOLDERED" | wc -c`);
    }

    if (text.endsWith("ask me for a key")) {
        return call("secret_request", { name: "NEW_KEY", description: "A key for the test" });
    }

    if (text.endsWith("save one")) {
        // The command makes the value: its text does not hold it.
        return call("secret_save", {
            name: "MADE",
            command: "echo generated-$((40 + 2))-value",
            description: "made",
        });
    }

    if (text.endsWith("save a copy")) {
        return call("secret_save", {
            name: "COPY",
            command: `printf '%s' "$TOKEN"`,
            description: "a copy",
        });
    }

    if (text.endsWith("list them")) {
        return call("secrets_list", {});
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
});

/** Put the module into a data folder's drop-ins, as the gallery does. */
function install(dataDir: string): void {
    const dropIns = join(dataDir, "extensions");

    mkdirSync(dropIns, { recursive: true });
    cpSync(join(import.meta.dirname, "secrets.ts"), join(dropIns, "secrets.ts"));
    cpSync(join(import.meta.dirname, "secrets"), join(dropIns, "secrets"), { recursive: true });
}

/** Write the store's file, as the sheet would have. */
function seed(
    dataDir: string,
    ownerId: string | undefined,
    secrets: Record<string, Record<string, unknown>>,
): void {
    mkdirSync(join(dataDir, "secrets"), { recursive: true });
    const now = Date.now();

    writeFileSync(
        join(dataDir, "secrets", "secrets.json"),
        JSON.stringify({
            version: 1,
            ...(ownerId === undefined ? {} : { owner: ownerId }),
            secrets: Object.fromEntries(
                Object.entries(secrets).map(([name, fields]) => [
                    name,
                    {
                        name,
                        description: "",
                        folders: [],
                        guests: false,
                        ask: false,
                        createdAt: now,
                        updatedAt: now,
                        ...fields,
                    },
                ]),
            ),
        }),
        { mode: 0o600 },
    );
}

const dataDir = join(root, "data");
let app: App;
let server: Server;
let base = "";
let guest: { user: { id: string; name: string }; token: string };

before(async () => {
    install(dataDir);
    app = await openApp(model, dataDir);
    seed(dataDir, owner(app).id, {
        TOKEN: { value: TOKEN, description: "the test token" },
        ASKED: { value: ASKED, ask: true },
        GUESTS: { value: GUESTS, guests: true },
        FOLDERED: { value: FOLDERED, folders: [join(work, "acme")] },
    });
    await app.setExtensionEnabled(owner(app), "secrets.ts", true);
    guest = app.config.addUser("Alex", "guest");
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** What a session stored: its entries, as JSON. */
const stored = async (id: Id) => JSON.stringify(await app.transcripts.allEntries(id, true));

/** The last text the model read in a session: the tool's result, after "ok: ". */
const lastSeen = async (id: Id) => (await modelTexts(app, id)).at(-1) ?? "";

/** Send as someone (not waiting for a card), and give back how to wait for the run. */
async function submit(id: Id, user: unknown, text: string) {
    const { submissionId } = await app.commands.submit(id, user as never, {
        text,
        requestId: crypto.randomUUID(),
    });

    return async () =>
        (await app.harness.submission(submissionId, helpers.context))!.wait(helpers.context);
}

async function http(who: "owner" | "guest", path: string, method = "GET", body?: unknown) {
    const token = who === "owner" ? app.config.ownerToken : guest.token;
    const response = await fetch(`${base}/api/x/secrets/${path}`, {
        method,
        headers: {
            authorization: `Bearer ${token}`,
            "x-pocket": "1",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();

    return { status: response.status, text };
}

test("a command that names a secret gets its value; the call keeps the name, and output shows [secret NAME]", async () => {
    const id = await newSession(app);

    await say(app, id, "use the token");

    const seen = await lastSeen(id);

    assert.match(
        seen,
        new RegExp(`\\b${TOKEN.length}\\b`),
        "the command had the value: its length",
    );
    assert.match(seen, /v=\[secret TOKEN\]/);
    assert.ok(!(await stored(id)).includes(TOKEN), "nothing stored holds the value");
    assert.ok((await stored(id)).includes('\\"$TOKEN\\"'), "the stored call keeps the name");
    assert.ok(!sent.join("").includes(TOKEN), "no request to the model holds the value");
});

test("its base64 and URL-encoded forms are hidden too", async () => {
    const id = await newSession(app);

    await say(app, id, "encode the token");

    const seen = await lastSeen(id);

    assert.ok(!seen.includes(Buffer.from(TOKEN).toString("base64")), seen);
    assert.ok(!seen.includes(encodeURIComponent(TOKEN)), seen);
    assert.equal(seen.match(/\[secret TOKEN\]/g)?.length, 2, seen);
});

test("a secret is not given outside its folders, and Pi is told why", async () => {
    const elsewhere = join(root, "elsewhere");

    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(work, "acme"), { recursive: true });
    const out = await newSession(app, elsewhere);

    await say(app, out, "use the foldered one");
    assert.match(await lastSeen(out), /\$FOLDERED may be used only in/);

    const inside = await newSession(app, join(work, "acme"));

    await say(app, inside, "use the foldered one");
    assert.match(await lastSeen(inside), new RegExp(`\\b${FOLDERED.length}\\b`));
});

test("a secret that asks first: Decline blocks the command, Allow runs it with the value", async () => {
    const id = await newSession(app);
    let done = await submit(id, owner(app), "use the asked one");

    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    await app.answerApproval(app.approvals.forConversation(id)[0]!.id, false, owner(app));
    await done();
    assert.match(await lastSeen(id), /did not allow \$ASKED/);

    done = await submit(id, owner(app), "use the asked one");
    await until(() => app.approvals.forConversation(id).length === 1, "the second card");
    await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app));
    await done();
    assert.match(await lastSeen(id), new RegExp(`\\b${ASKED.length}\\b`));
});

test("a guest's message does not use the owner's secret; one that allows guests runs", async () => {
    const id = await newSession(app);

    await (
        await submit(id, guest.user, "use the token")
    )();
    assert.match(await lastSeen(id), /\$TOKEN is the owner's/);

    await (
        await submit(id, guest.user, "use the guests one")
    )();
    assert.match(await lastSeen(id), new RegExp(`\\b${GUESTS.length}\\b`));
});

test("a value that someone pastes into a message is stored as [secret NAME]", async () => {
    const id = await newSession(app);

    await say(app, id, `here it is: ${TOKEN}`);
    assert.ok(!(await stored(id)).includes(TOKEN));
    assert.match(await stored(id), /here it is: \[secret TOKEN\]/);
});

test("secret_request: the owner types the value on a card; Pi gets 'saved', and nothing stored holds it", async () => {
    const id = await newSession(app);
    const done = await submit(id, owner(app), "ask me for a key");

    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    const [card] = app.approvals.forConversation(id);

    // A plain Allow is not an answer: the field must be filled in.
    await assert.rejects(app.answerApproval(card!.id, true, owner(app)), { status: 400 });
    await app.answerApproval(card!.id, true, owner(app), { value: "brand-new-key-0001" });
    await done();
    assert.match(await lastSeen(id), /Saved NEW_KEY/);
    assert.ok(!(await stored(id)).includes("brand-new-key-0001"));
    assert.ok(
        readFileSync(join(dataDir, "secrets", "secrets.json"), "utf8").includes(
            "brand-new-key-0001",
        ),
    );

    // A guest's message does not get the card.
    const other = await newSession(app);

    await (
        await submit(other, guest.user, "ask me for a key")
    )();
    assert.match(await lastSeen(other), /Only the owner keeps secrets/);
});

/** Send as the owner, then answer the card that comes: allow or decline. */
async function sayAndAnswer(id: Id, text: string, allow: boolean) {
    const done = await submit(id, owner(app), text);

    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    await app.answerApproval(app.approvals.forConversation(id)[0]!.id, allow, owner(app));
    await done();
}

test("secret_save runs only the command the owner allowed, and keeps its output; a copy keeps the value", async () => {
    const id = await newSession(app);

    await sayAndAnswer(id, "save one", false);
    assert.match(await lastSeen(id), /declined: nothing was run/);
    assert.ok(!readFileSync(join(dataDir, "secrets", "secrets.json"), "utf8").includes("MADE"));

    await sayAndAnswer(id, "save one", true);
    assert.match(await lastSeen(id), /Saved MADE \(18 characters\)/);
    assert.ok(!(await stored(id)).includes("generated-42-value"));

    await sayAndAnswer(id, "save a copy", true);
    const file = JSON.parse(readFileSync(join(dataDir, "secrets", "secrets.json"), "utf8"));

    assert.equal(file.secrets.MADE.value, "generated-42-value");
    assert.equal(file.secrets.COPY.value, TOKEN);
});

test("secrets_list runs in plan mode; secret_save waits for the plan", async () => {
    const id = await newSession(app);

    await app.commands.setPlan(id, owner(app), true);
    await say(app, id, "list them");
    assert.match(await lastSeen(id), /\$TOKEN \(the test token\)/);
    await say(app, id, "save one");
    assert.doesNotMatch(await lastSeen(id), /Saved MADE/);
});

test("the routes are the owner's, never give a value, and the file is the server's alone", async () => {
    const list = await http("owner", "secrets");

    assert.equal(list.status, 200);
    assert.ok(list.text.includes('"TOKEN"'));
    assert.ok(!list.text.includes(TOKEN));

    for (const [path, method] of [
        ["secrets", "GET"],
        ["hello", "POST"],
        ["secrets/TOKEN", "DELETE"],
    ] as const) {
        assert.equal(
            (await http("guest", path, method, method === "GET" ? undefined : {})).status,
            404,
            path,
        );
    }

    const put = await http("owner", "secrets/ADDED", "PUT", {
        value: "added-by-the-sheet",
        description: "x",
    });

    assert.equal(put.status, 200);
    assert.ok(!put.text.includes("added-by-the-sheet"));
    assert.equal((await http("owner", "secrets/SHORT", "PUT", { value: "short" })).status, 400);
    assert.equal((await http("owner", "secrets/ADDED", "DELETE")).status, 200);
    assert.equal(statSync(join(dataDir, "secrets", "secrets.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dataDir, "secrets")).mode & 0o777, 0o700);
});

test("a file that cannot be read is moved aside, and the module still loads", async () => {
    const other = join(root, "broken");

    install(other);
    mkdirSync(join(other, "secrets"), { recursive: true });
    writeFileSync(join(other, "secrets", "secrets.json"), "{ not json");
    const second = await openApp(model, other);

    try {
        await second.setExtensionEnabled(owner(second), "secrets.ts", true);
        assert.ok(
            readdirSync(join(other, "secrets")).some((name) =>
                name.startsWith("secrets.json.bad-"),
            ),
        );
        assert.ok(!existsSync(join(other, "secrets", "secrets.json")));
    } finally {
        await second.close();
    }
});

test("off: commands get nothing, and nothing is hidden", async () => {
    await app.setExtensionEnabled(owner(app), "secrets.ts", false);

    try {
        const id = await newSession(app);

        await say(app, id, "use the token");
        assert.match(await lastSeen(id), /\b0\b/, "an empty $TOKEN");
    } finally {
        await app.setExtensionEnabled(owner(app), "secrets.ts", true);
    }
});

test("until the owner's tab says who the owner is, a known person's command gets no secret", async () => {
    const other = join(root, "unknown");

    install(other);
    const third = await openApp(model, other);

    try {
        seed(other, undefined, { TOKEN: { value: TOKEN } });
        await third.setExtensionEnabled(owner(third), "secrets.ts", true);
        const id = await newSession(third);
        const run = async () => {
            const { submissionId } = await third.commands.submit(id, owner(third), {
                text: "use the token",
                requestId: crypto.randomUUID(),
            });

            await (await third.harness.submission(submissionId, helpers.context))!.wait(
                helpers.context,
            );

            return (await modelTexts(third, id)).at(-1) ?? "";
        };

        assert.match(await run(), /waits until the owner opens Pi Pocket/);

        // The owner's tab says hello.
        const handler = createServer(
            createHandler({
                app: third,
                listen: { host: "127.0.0.1", port: 0 },
                restart: () => {},
            }),
        );

        await new Promise<void>((done) => handler.listen(0, "127.0.0.1", done));

        try {
            const port = (handler.address() as { port: number }).port;
            const hello = await fetch(`http://127.0.0.1:${port}/api/x/secrets/hello`, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${third.config.ownerToken}`,
                    "x-pocket": "1",
                    "content-type": "application/json",
                },
                body: "{}",
            });

            assert.equal(hello.status, 200);
        } finally {
            handler.closeAllConnections();
            handler.close();
        }

        assert.match(await run(), new RegExp(`\\b${TOKEN.length}\\b`));
    } finally {
        await third.close();
    }
});
