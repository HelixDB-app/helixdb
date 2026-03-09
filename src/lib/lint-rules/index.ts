import type { LintRule } from "@/lib/lint-rules/types";
import { ambiguousColumnsRule } from "@/lib/lint-rules/ambiguous-columns";
import { deprecatedSyntaxRule } from "@/lib/lint-rules/deprecated-syntax";
import { implicitCastRule } from "@/lib/lint-rules/implicit-cast";
import { missingWhereRule } from "@/lib/lint-rules/missing-where";
import { nPlusOneRule } from "@/lib/lint-rules/n-plus-one";
import { selectStarRule } from "@/lib/lint-rules/select-star";
import { unusedJoinsRule } from "@/lib/lint-rules/unused-joins";

export const builtInRules: LintRule[] = [
    missingWhereRule,
    selectStarRule,
    implicitCastRule,
    unusedJoinsRule,
    ambiguousColumnsRule,
    deprecatedSyntaxRule,
    nPlusOneRule,
];

export {
    ambiguousColumnsRule,
    deprecatedSyntaxRule,
    implicitCastRule,
    missingWhereRule,
    nPlusOneRule,
    selectStarRule,
    unusedJoinsRule,
};
