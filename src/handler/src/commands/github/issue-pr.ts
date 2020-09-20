import { Args } from 'lexure';
import { injectable, inject } from 'tsyringe';
import { Message, Embed } from '@spectacles/types';
import { Sql } from 'postgres';
import fetch from 'node-fetch';
import i18next from 'i18next';
import Rest from '@yuudachi/rest';
import { addField, truncateEmbed } from '../../../util';

import Command from '../../Command';
import { kSQL } from '../../tokens';
import { GitHubAPIData, isPR, GitHubReviewDecision, GitHubReviewState } from '../../interfaces/GitHub';

// #region typings // TODO: remove section (indev)

const BASE_URL = 'https://api.github.com/graphql';

enum ResultStatePR {
	OPEN = 'OPEN',
	CLOSED = 'CLOSED',
	MERGED = 'MERGED',
	DRAFT = 'DRAFT',
}

enum ResultStateIssue {
	OPEN = 'OPEN',
	CLOSED = 'CLOSED',
}

enum InstallableState {
	OPEN = 'OPEN',
	DRAFT = 'DRAFT',
}

enum StateColors {
	OPEN = 4827469,
	CLOSED = 12267569,
	MERGED = 6441376,
	DRAFT = 12961221,
}

const Timestamps = {
	OPEN: 'publishedAt',
	CLOSED: 'closedAt',
	MERGED: 'mergedAt',
	DRAFT: 'publishedAt',
} as const;

interface RepositoryEntry {
	owner: string;
	repository: string;
}

type TimestampsWithoutMerged = Omit<typeof Timestamps, 'MERGED'>;

type TimestampsWithoutMergedKey = TimestampsWithoutMerged[keyof TimestampsWithoutMerged];

enum PRIcons {
	OPEN = 'https://cdn.discordapp.com/emojis/751210109333405727.png',
	CLOSED = 'https://cdn.discordapp.com/emojis/751210080459817092.png',
	MERGED = 'https://cdn.discordapp.com/emojis/751210169609748481.png',
	DRAFT = 'https://cdn.discordapp.com/emojis/751210097463525377.png',
}

enum IssueIcons {
	OPEN = 'https://cdn.discordapp.com/emojis/751210140086042686.png?v=1',
	CLOSED = 'https://cdn.discordapp.com/emojis/751210129977901100.png',
}

// #endregion typings

@injectable()
export default class IssuePRLookup implements Command {
	public constructor(private readonly rest: Rest, @inject(kSQL) private readonly sql: Sql<any>) {}

	public async execute(message: Message, args: Args, locale: string) {
		if (!message.guild_id) {
			return;
		}

		const githubToken = process.env.GITHUB_TOKEN;
		if (!githubToken) {
			throw new Error(i18next.t('command.issue-pr.execute.no_token', { lng: locale }));
		}

		const first = args.single();
		const second = args.single();
		const third = args.single();

		if (!first) {
			throw new Error(i18next.t('TODO', { lng: locale }));
		}

		const repositoryAliases = await this.fetchAliases(message.guild_id);
		const aliasEntry = repositoryAliases.get(first);

		const owner = third ? first : aliasEntry?.owner;
		const repository = third ? second : aliasEntry?.repository;
		const num = third ? third : second;

		if (!owner || !repository || !num) {
			throw new Error(i18next.t('TODO', { lng: locale }));
		}

		if (!IssuePRLookup.validateGitHubName(owner)) {
			throw new Error(i18next.t('TODO', { lng: locale }));
		}

		if (!IssuePRLookup.validateGitHubName(repository)) {
			throw new Error(i18next.t('TODO', { lng: locale }));
		}

		if (isNaN(parseInt(num, 10))) {
			throw new Error(i18next.t('TODO', { lng: locale }));
		}

		try {
			const query = IssuePRLookup.buildQuery(owner, repository, num);
			const res = await fetch(BASE_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${githubToken}`,
				},
				body: JSON.stringify({ query }),
			}).then((res) => res.json());

			if (!res?.data?.repository?.issueOrPullRequest) {
				return;
			}

			const data = res.data as GitHubAPIData;
			const issue = data.repository.issueOrPullRequest;
			const resultState = isPR(issue)
				? issue.merged
					? ResultStatePR.MERGED
					: issue.isDraft
					? ResultStatePR.DRAFT
					: issue.closed
					? ResultStatePR.CLOSED
					: ResultStatePR.OPEN
				: issue.closed
				? ResultStateIssue.CLOSED
				: ResultStateIssue.OPEN;

			// footer icon
			const icon_url = isPR(issue)
				? PRIcons[resultState as ResultStatePR]
				: IssueIcons[resultState as ResultStateIssue];

			// footer text
			const comments = issue.comments.totalCount
				? `(${i18next.t('command.issue-pr.execute.comment_count', { lng: locale, count: issue.comments.totalCount })})`
				: '';

			const isMerge = isPR(issue) && resultState === 'MERGED';
			const user = isPR(issue) && resultState === 'MERGED' ? issue.mergedBy?.login : undefined;
			const commit = isPR(issue) && resultState === 'MERGED' ? issue.mergeCommit?.abbreviatedOid : undefined;

			const action = isMerge
				? user && commit
					? i18next.t('command.issue-pr.execute.action.merge_by_in', { lng: locale, user, commit })
					: user
					? i18next.t('command.issue-pr.execute.action.merge_by', { lng: locale, user })
					: commit
					? i18next.t('command.issue-pr.execute.action.merge_in', { lng: locale, commit })
					: i18next.t('command.issue-pr.execute.action.merge', { lng: locale })
				: resultState === 'CLOSED'
				? i18next.t('command.issue-pr.execute.action.close', { lng: locale })
				: resultState === 'DRAFT'
				? i18next.t('command.issue-pr.execute.action.draft', { lng: locale })
				: i18next.t('command.issue-pr.execute.action.open', { lng: locale });

			const footerText = `${comments} ${action}`;

			// timestamp
			const timestampProperty = Timestamps[resultState];

			const e1: Embed = {
				author: {
					icon_url: `${issue.author.avatarUrl}?anticache=${Date.now()}`,
					name: issue.author.login,
					url: issue.author.url,
				},
				title: `#${issue.number} ${issue.title}`,
				url: issue.url,
				footer: { text: footerText, icon_url },
				color: StateColors[resultState],
				timestamp: isPR(issue) ? issue[timestampProperty]! : issue[timestampProperty as TimestampsWithoutMergedKey]!,
			};

			// install with
			const installable = Reflect.has(InstallableState, resultState);
			const e2: Embed =
				isPR(issue) && installable
					? addField(e1, {
							name: i18next.t('command.issue-pr.execute.heading.install', { lng: locale }),
							value: `\`npm i ${issue.headRepository.nameWithOwner}#${
								issue.headRef?.name ?? i18next.t('command.issue-pr.execute.unknown', { lng: locale }) ?? ''
							}\``,
					  })
					: e1;

			// reviews
			const reviews = isPR(issue) ? issue.latestOpinionatedReviews?.nodes ?? [] : [];
			const reviewBody = reviews
				.map((r) => {
					const decision = isPR(issue)
						? r.state === GitHubReviewState['CHANGES_REQUESTED']
							? i18next.t('command.issue-pr.execute.review_state.changes_requested', { lng: locale })
							: r.state === GitHubReviewState['APPROVED']
							? i18next.t('command.issue-pr.execute.review_state.approved', { lng: locale })
							: r.state === GitHubReviewState['COMMENTED']
							? i18next.t('command.issue-pr.execute.review_state.commented', { lng: locale })
							: r.state === GitHubReviewState['DISMISSED']
							? i18next.t('command.issue-pr.execute.review_state.dismissed', { lng: locale })
							: i18next.t('command.issue-pr.execute.review_state.pending', { lng: locale })
						: '';
					return `${r.author.login} [${decision}](${r.url})`;
				})
				.join(', ');

			const reviewTitle = isPR(issue)
				? issue.reviewDecision === GitHubReviewDecision['CHANGES_REQUESTED']
					? i18next.t('command.issue-pr.execute.heading.reviews.changes_requested', { lng: locale })
					: issue.reviewDecision === GitHubReviewDecision['APPROVED']
					? i18next.t('command.issue-pr.execute.heading.reviews.approved', { lng: locale })
					: i18next.t('command.issue-pr.execute.heading.reviews.review_required', { lng: locale })
				: '';

			const e3: Embed = reviews.length ? addField(e2, { name: reviewTitle, value: reviewBody }) : e2;

			this.rest.post(`/channels/${message.channel_id}/messages`, {
				embed: truncateEmbed(e3),
			});
		} catch (e) {
			console.error(e); // TODO: REMOVE
		}
	}

	private static validateGitHubName(name: string): boolean {
		const reg = /[A-Za-z0-9_.-]+/;
		const match = reg.exec(name);
		return name.length === match?.[0].length;
	}

	private static buildQuery(owner: string, repository: string, issueID: string) {
		return `
		{
			repository(owner: "${owner}", name: "${repository}") {
				name
				issueOrPullRequest(number: ${issueID}) {
					... on PullRequest {
						commits(last: 1) {
							nodes {
								commit {
									abbreviatedOid
								}
							}
						}
						author {
							avatarUrl
							login
							url
						}
						body
						merged
						mergeCommit {
							abbreviatedOid
						}
						headRef {
							name
						}
						headRepository {
							nameWithOwner
						}
						mergedAt
						mergedBy {
							login
						}
						isDraft
						number
						publishedAt
						title
						url
						closed
						comments {
							totalCount
						}
						reviewDecision
						latestOpinionatedReviews(last: 99) {
							nodes {
								author {
									login
								}
								state
								url
							}
						}
					}
					... on Issue {
						author {
							avatarUrl
							login
							url
						}
						body
						number
						publishedAt
						title
						url
						closed
						closedAt
						comments {
							totalCount
						}
					}
				}
			}
		}`;
	}

	private async fetchAliases(guild: string): Promise<Map<string, RepositoryEntry>> {
		const [result] = await this.sql<{ repository_aliases: string[] }>`
			select repository_aliases
			from guild_settings
			where guild_id = ${guild}
		`;

		const mapping: Map<string, RepositoryEntry> = new Map();

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (!result?.repository_aliases?.length) {
			return mapping;
		}

		for (const r of result.repository_aliases) {
			const [alias, rest] = r.split(':');
			const [owner, repository] = rest.split('/');
			mapping.set(alias, { owner, repository });
		}

		return mapping;
	}
}
