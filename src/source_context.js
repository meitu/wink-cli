"use strict";

const SOURCE_FLAGS = ["expert-id", "source-name", "source-type"];
function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function validateSourceFlags(flags, ErrorType = Error) {
  for (const key of SOURCE_FLAGS) {
    if (flags[key] !== undefined && !text(flags[key])) {
      throw new ErrorType(`--${key} 需要非空来源值`);
    }
  }
  if (flags["source-type"] !== undefined && !["expert", "skill"].includes(flags["source-type"])) {
    throw new ErrorType("--source-type 仅支持 expert 或 skill（小写）");
  }
}
function resolveSourceContext({ expertId, sourceName, sourceType, env = process.env } = {}) {
  const id = text(expertId) || text(env.WINK_EXPERT_ID);
  const type = text(sourceType) || text(env.WINK_SOURCE_TYPE);
  return {
    expert_id: id ? text(id.replace(/^(?:expert_|skill_)+/, "")) : null,
    source_name: text(sourceName) || text(env.WINK_SOURCE_NAME),
    source_type: ["expert", "skill"].includes(type) ? type : null,
  };
}
module.exports = { SOURCE_FLAGS, validateSourceFlags, resolveSourceContext };
