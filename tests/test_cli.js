"use strict";
// Wink CLI（src/cli.js）离线测试：
// 帮助文案锁定、参数解析、档位表 → task type 映射、输入展开、输出命名、凭据/目录默认值。
// 全程不发网络请求。

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const cli = require("../src/cli");

const TOTAL = 10;
let passed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      process.stdout.write(`  ok ${passed}/${TOTAL} ${name}\n`);
    });
}

/** 同时捕获 stdout / stderr，用于断言帮助文案与错误输出。 */
async function capture(fn) {
  const outChunks = [];
  const errChunks = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => { outChunks.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { errChunks.push(String(chunk)); return true; };
  try {
    const value = await fn();
    return { value, stdout: outChunks.join(""), stderr: errChunks.join("") };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

// ---------------------------------------------------------------- 用例

async function testMainHelp() {
  const expected = cli.MAIN_HELP;
  const names = ["picture_quality", "resolution_repair", "remove_watermark", "denoise", "color_enhance", "color_unite", "cartoon", "night_scene", "video_frame", "ai_translation", "ai_beauty", "video_defogging", "old_photo"];
  assert.strictEqual(Object.keys(cli.COMMANDS).length, names.length);
  for (const name of names) {
    assert.ok(expected.includes(name));
    const help = await capture(() => cli.main([name, "--help"]));
    assert.strictEqual(help.value, 0);
    if (!["picture_quality", "remove_watermark", "video_frame"].includes(name)) assert.ok(!help.stdout.includes("--level"), name);
  }

  // 无参数 与 --help / -h 都显示主帮助并返回 0
  for (const argv of [[], ["--help"], ["-h"]]) {
    const run = await capture(() => cli.main(argv));
    assert.strictEqual(run.value, 0, `wink-cli ${argv.join(" ")} 退出码应为 0`);
    assert.strictEqual(run.stdout.trimEnd(), expected.trimEnd(), `wink-cli ${argv.join(" ")} 应输出主帮助`);
  }
}

async function testSubcommandHelp() {
  const run = await capture(() => cli.main(["picture_quality", "--help"]));
  assert.strictEqual(run.value, 0, "picture_quality --help 退出码应为 0");
  const text = run.stdout;
  assert.ok(text.includes("picture_quality — 画质修复（云端工具箱）"), "应含子命令标题");
  assert.ok(text.includes("档位 (--level):"), "应含档位小节");
  assert.ok(text.includes("  2   超清（默认）"), "档位 2 应标注默认");
  assert.ok(text.includes("  5   商品图  — 仅图片"), "商品图应标注仅图片");
  assert.ok(text.includes("  6   文字图表  — 仅图片"), "文字图表应标注仅图片");
  assert.ok(text.includes("  9   高糊图  — 仅图片"), "高糊图应标注仅图片");
  assert.ok(text.includes("仅显示下载链接"), "应说明链接输出模式");

  const watermark = await capture(() => cli.main(["remove_watermark", "--help"]));
  assert.strictEqual(watermark.value, 0);
  assert.ok(watermark.stdout.includes("1   自动去印（默认）"));
  assert.ok(watermark.stdout.includes("2   AI去水印"));
  assert.ok(!watermark.stdout.includes("超清"));

  const unknown = await capture(() => cli.main(["nope"]));
  assert.strictEqual(unknown.value, 1, "未知命令退出码应为 1");
  assert.ok(unknown.stderr.includes("未知命令: nope"), "未知命令应报错");
  assert.ok(unknown.stdout.includes("欢迎使用美图wink cli"), "未知命令应回落到主帮助");
}

async function testParseArgv() {
  const parsed = cli.parseArgv([
    "picture_quality", "--level", "2", "--input", "a.mp4,b.mp4", "--output", "D:\\result\\", "--force",
  ]);
  assert.deepStrictEqual(parsed._, ["picture_quality"], "位置参数应只含子命令");
  assert.strictEqual(parsed.flags.level, "2");
  assert.strictEqual(parsed.flags.input, "a.mp4,b.mp4");
  assert.strictEqual(parsed.flags.output, "D:\\result\\");
  assert.strictEqual(parsed.flags.force, true, "布尔开关应为 true");

  const eq = cli.parseArgv(["picture_quality", "--level=3", "--input=/tmp/a.jpg"]);
  assert.strictEqual(eq.flags.level, "3", "--key=value 形式应被识别");
  assert.strictEqual(eq.flags.input, "/tmp/a.jpg");

  const short = cli.parseArgv(["-h"]);
  assert.deepStrictEqual(cli.optionFlag(short.flags, "help", "h"), true, "-h 应识别为 help");
  assert.strictEqual(cli.optionValue({ only: true }, "only"), undefined, "只写了 --flag 时不应误当值");
}

async function testLevelTable() {
  assert.strictEqual(cli.DEFAULT_LEVEL, 2, "默认档位应为 2（与参考实现一致）");
  assert.strictEqual(cli.levelInfo(2).name, "超清", "档位 2 应为超清");
  assert.strictEqual(cli.levelInfo(1).name, "高清");
  assert.strictEqual(cli.levelInfo(99), null, "不存在的档位应为 null");
  assert.strictEqual(cli.PICTURE_QUALITY_LEVELS.length, 12, "对外档位应为 1..12");

  // 档位 + 媒体类型 → /task/submit 的 type（图片/视频两套值）
  assert.strictEqual(cli.taskTypeFor(1, "1").taskType, "2", "高清 图片 → type=2");
  assert.strictEqual(cli.taskTypeFor(1, "2").taskType, "1", "高清 视频 → type=1");
  assert.strictEqual(cli.taskTypeFor(2, "1").taskType, "12", "超清 图片 → type=12");
  assert.strictEqual(cli.taskTypeFor(2, "2").taskType, "11", "超清 视频 → type=11");
  assert.strictEqual(cli.taskTypeFor(5, "1").taskType, "72", "商品图 图片 → type=72");
  assert.strictEqual(cli.taskTypeFor(10, "2").taskType, "129", "演唱会 视频 → type=129");

  // 仅图片档位给视频、或档位不存在 → 必须先报错而不是投错 type
  assert.throws(() => cli.taskTypeFor(5, "2"), /仅支持|不支持视频输入/, "商品图不支持视频");
  assert.throws(() => cli.taskTypeFor(6, "2"), /不支持视频输入/, "文字图表不支持视频");
  assert.throws(() => cli.taskTypeFor(9, "2"), /不支持视频输入/, "高糊图不支持视频");
  assert.throws(() => cli.taskTypeFor(99, "1"), /不支持的档位/, "未知档位应报错");
  assert.strictEqual(cli.taskTypeFor(1, "1", "remove_watermark").taskType, "8");
  assert.strictEqual(cli.taskTypeFor(1, "2", "remove_watermark").taskType, "3");
  assert.strictEqual(cli.taskTypeFor(2, "1", "remove_watermark").taskType, "95");
  assert.strictEqual(cli.taskTypeFor(2, "2", "remove_watermark").taskType, "94");
  assert.throws(() => cli.taskTypeFor(3, "1", "remove_watermark"), /不支持的档位/);
}

async function testSplitInputs() {
  assert.deepStrictEqual(cli.splitInputs("a.mp4,b.mp4"), ["a.mp4", "b.mp4"], "英文逗号分隔");
  assert.deepStrictEqual(cli.splitInputs(" a.mp4 , b.mp4 "), ["a.mp4", "b.mp4"], "应去除空白");
  assert.deepStrictEqual(cli.splitInputs("a.jpg，b.jpg"), ["a.jpg", "b.jpg"], "中文逗号也应兼容");
  assert.deepStrictEqual(cli.splitInputs("a.jpg,,b.jpg,"), ["a.jpg", "b.jpg"], "应跳过空项");
}

async function testContentType() {
  assert.strictEqual(cli.contentTypeOfFile("/x/a.JPG"), "1", "图片 → 1");
  assert.strictEqual(cli.contentTypeOfFile("C:\\v\\clip.MP4"), "2", "视频 → 2");
  assert.strictEqual(cli.contentTypeOfFile("/x/notes.txt"), "", "非媒体 → 空");
}

async function testCollectInputs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wink-cli-"));
  try {
    const nested = path.join(root, "sub");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(root, "a.jpg"), "x");
    fs.writeFileSync(path.join(nested, "b.mp4"), "x");
    fs.writeFileSync(path.join(root, "c.txt"), "x");
    fs.writeFileSync(path.join(root, ".DS_Store"), "x");

    const dirResult = cli.collectInputs([root]);
    assert.deepStrictEqual(
      dirResult.files.map((f) => path.basename(f)).sort(),
      ["a.jpg", "b.mp4"],
      "目录应递归收集媒体文件并跳过非媒体/隐藏文件",
    );
    assert.deepStrictEqual(dirResult.skipped.map((f) => path.basename(f)), ["c.txt"], "非媒体应计入 skipped");

    const multi = cli.collectInputs([path.join(root, "a.jpg"), path.join(root, "sub")]);
    assert.strictEqual(multi.files.length, 2, "多路径应合并展开");

    const missing = cli.collectInputs([path.join(root, "nope.mp4")]);
    assert.deepStrictEqual(missing.missing, [path.join(root, "nope.mp4")], "不存在的路径应计入 missing");
    assert.strictEqual(missing.files.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function testOutputNaming() {
  const saved = process.env.WINK_OUTPUT_DIR;
  try {
    process.env.WINK_OUTPUT_DIR = "/tmp/wink-out-test";
    assert.strictEqual(cli.defaultOutputDir(), "/tmp/wink-out-test", "WINK_OUTPUT_DIR 应优先");
    delete process.env.WINK_OUTPUT_DIR;
    assert.ok(cli.defaultOutputDir().length > 0, "无 env 时应回落到平台缓存目录");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wink-cli-out-"));
    try {
      const used = new Set();
      const remote = "https://mt-wink-storage-pre.meitudata.com/temp/abc.jpg?k=1&t=2";
      const first = cli.uniqueOutputPath(dir, "/in/photo.png", remote, false, used);
      assert.strictEqual(path.basename(first), "photo-result.jpg", "应按结果扩展名命名");

      // 同批次第二个同名输入：不能互相覆盖，应加序号
      const second = cli.uniqueOutputPath(dir, "/other/photo.png", remote, false, used);
      assert.strictEqual(path.basename(second), "photo-result-1.jpg", "同批次重名应自动加序号");
      assert.notStrictEqual(first, second);

      // 已存在的文件也要避让
      fs.writeFileSync(path.join(dir, "solo-result.jpg"), "x");
      const third = cli.uniqueOutputPath(dir, "/in/solo.png", remote, false, new Set());
      assert.strictEqual(path.basename(third), "solo-result-1.jpg", "磁盘已存在应自动加序号");

      // force 时保持原名（覆盖语义）
      const forced = cli.uniqueOutputPath(dir, "/in/solo.png", remote, true, new Set());
      assert.strictEqual(path.basename(forced), "solo-result.jpg", "--force 应使用原名覆盖");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (saved === undefined) delete process.env.WINK_OUTPUT_DIR;
    else process.env.WINK_OUTPUT_DIR = saved;
  }
}

async function testUsageErrors() {
  // 缺 --input
  const noInput = await capture(() => cli.main(["picture_quality"]));
  assert.strictEqual(noInput.value, 1, "缺 --input 应返回 1");
  assert.ok(noInput.stderr.includes("--input 为必填项"), "应提示 --input 必填");

  // 非法档位
  const badLevel = await capture(() => cli.main(["picture_quality", "--level", "99", "--input", "/tmp/a.jpg"]));
  assert.strictEqual(badLevel.value, 1, "非法档位应返回 1");
  assert.ok(badLevel.stderr.includes("不支持的档位"), "应提示档位不支持");

  // 输入全部不存在
  const noFiles = await capture(() => cli.main(["picture_quality", "--level", "2", "--input", "/definitely/not/here.mp4"]));
  assert.strictEqual(noFiles.value, 1, "无可用输入应返回 1");
  assert.ok(noFiles.stderr.includes("没有找到可处理的输入媒体文件"), "应提示无可用输入");
}

async function testImageDimensions() {
  const saved = process.env.WINK_FFPROBE_PATH;
  try {
    // This executable exists but cannot handle ffprobe arguments: successful reads
    // demonstrate that images never invoke it when the header is recognized.
    process.env.WINK_FFPROBE_PATH = process.execPath;
    for (const [ext, width, height] of [["jpg", 16, 12], ["png", 16, 12], ["webp", 1, 1]]) {
      const file = path.join(__dirname, "fixtures", "images", `sample.${ext}`);
      assert.deepStrictEqual(cli.probeMedia(file), { width, height, size: fs.statSync(file).size });
    }
  } finally {
    if (saved === undefined) delete process.env.WINK_FFPROBE_PATH;
    else process.env.WINK_FFPROBE_PATH = saved;
  }
}

// ---------------------------------------------------------------- 运行

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wink-cli-test-"));
  try {
    await test("主帮助文案与 wink-cli/--help/-h 行为", testMainHelp);
    await test("子命令帮助与未知命令", testSubcommandHelp);
    await test("argv 解析", testParseArgv);
    await test("档位表 → task type 映射", testLevelTable);
    await test("--input 分隔与去空", testSplitInputs);
    await test("媒体类型识别", testContentType);
    await test("输入展开（目录递归/多路径/缺失）", testCollectInputs);
    await test("输出目录默认值与结果文件命名", testOutputNaming);
    await test("用法错误退出码", testUsageErrors);
    await test("图片独立读取 JPG/PNG/WebP 宽高，不调用 ffprobe", testImageDimensions);
    process.stdout.write(`cli tests: ${passed} passed\n`);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
