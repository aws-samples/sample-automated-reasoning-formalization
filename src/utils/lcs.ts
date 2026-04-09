/**
 * Word-level Longest Common Subsequence (LCS) algorithm.
 * Used for fuzzy matching of fidelity report statements against source document text.
 */

export interface LCSResult {
  /** The words in the longest common subsequence, in order. */
  lcs: string[];
  /** Ratio of LCS length to the length of array `a` (the statement). */
  ratio: number;
}

/**
 * Compute the longest common subsequence of two word arrays.
 * Returns the LCS words (in order) and the match ratio
 * (LCS length / length of `a`).
 *
 * @param a - The statement words (typically shorter).
 * @param b - The candidate document region words (typically longer).
 */
export function wordLCS(a: string[], b: string[]): LCSResult {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return { lcs: [], ratio: 0 };

  // Build DP table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find the actual LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.push(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  lcs.reverse();

  return { lcs, ratio: m > 0 ? lcs.length / m : 0 };
}
