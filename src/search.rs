//! A deliberately small full-text search index.
//!
//! A personal notes app searching a few hundred or thousand short
//! markdown files doesn't need a full search-engine library: a plain
//! inverted index (word -> which notes contain it, how often) built in
//! memory and rebuilt from the files on disk gets you full-text search
//! in about 100 lines, with no index-corruption failure mode to debug -
//! if it's ever wrong, just restart and it rebuilds from the files,
//! which remain the only source of truth.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct SearchIndex {
    // token -> title -> occurrence count. BTreeMap (not HashMap) for
    // the outer index specifically so prefix search - the common case,
    // since partial words like "fold" should match "folding" - can use
    // a sorted range query instead of scanning every unique token in
    // the index on every search.
    inner: RwLock<BTreeMap<String, HashMap<String, usize>>>,
}

fn tokenize(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect()
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(BTreeMap::new()),
        }
    }

    /// Rebuild the whole index from scratch by re-reading the given notes.
    /// Called once at startup.
    pub fn rebuild<'a>(&self, notes: impl Iterator<Item = (&'a str, &'a str)>) {
        let mut index: BTreeMap<String, HashMap<String, usize>> = BTreeMap::new();
        for (title, content) in notes {
            index_one(&mut index, title, content);
        }
        *self.inner.write().unwrap() = index;
    }

    /// Remove a note's tokens then re-add its current content. Cheaper
    /// than a full rebuild, called after every create/update/delete so
    /// the index never drifts far from the files on disk even between
    /// restarts.
    pub fn update_note(&self, title: &str, content: Option<&str>) {
        let mut index = self.inner.write().unwrap();
        for postings in index.values_mut() {
            postings.remove(title);
        }
        index.retain(|_, postings| !postings.is_empty());
        if let Some(content) = content {
            index_one(&mut index, title, content);
        }
    }

    pub fn rename_note(&self, old_title: &str, new_title: &str) {
        let mut index = self.inner.write().unwrap();
        for postings in index.values_mut() {
            if let Some(count) = postings.remove(old_title) {
                postings.insert(new_title.to_string(), count);
            }
        }
    }

    /// Rank notes by summed term frequency across all query tokens that
    /// appear in the note, with an extra weight for tokens that also
    /// appear in the title (titles matter more than body hits).
    pub fn search(&self, query: &str) -> Vec<(String, usize)> {
        let query_tokens = tokenize(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let index = self.inner.read().unwrap();
        let mut scores: HashMap<String, usize> = HashMap::new();

        for token in &query_tokens {
            // Exact token matches, plus simple prefix matches so partial
            // words ("fold" matching "folding") still surface results.
            // BTreeMap keeps tokens in sorted order, so everything
            // starting with `token` sits in one contiguous range -
            // walk from there and stop the moment we're past it,
            // rather than checking every token in the whole index.
            for (indexed_token, postings) in index.range(token.clone()..) {
                if !indexed_token.starts_with(token.as_str()) {
                    break;
                }
                for (title, count) in postings {
                    *scores.entry(title.clone()).or_insert(0) += count;
                }
            }
        }

        // Title-match boost.
        for (title, score) in scores.iter_mut() {
            let title_tokens = tokenize(title);
            let hits = query_tokens
                .iter()
                .filter(|qt| title_tokens.iter().any(|tt| tt.starts_with(qt.as_str())))
                .count();
            if hits > 0 {
                *score += hits * 50;
            }
        }

        let mut results: Vec<(String, usize)> = scores.into_iter().collect();
        results.sort_by(|a, b| b.1.cmp(&a.1));
        results
    }
}

fn index_one(index: &mut BTreeMap<String, HashMap<String, usize>>, title: &str, content: &str) {
    // Index the title's own words too, not just the content - otherwise
    // a note whose only distinctive word is in its title (not the body)
    // is unfindable, since the separate title-match boost below only
    // re-ranks notes that already matched via content; it was never an
    // independent source of matches on its own.
    for token in tokenize(title).into_iter().chain(tokenize(content)) {
        *index
            .entry(token)
            .or_default()
            .entry(title.to_string())
            .or_insert(0) += 1;
    }
}
