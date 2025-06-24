import {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeOperationError,
	NodeConnectionType,
} from 'n8n-workflow';

import { readFile, writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface TranscriptItem {
	text: string;
	start: number;
	duration: number;
}

interface VideoMetadata {
	title?: string;
	duration?: number;
	uploader?: string;
	upload_date?: string;
	view_count?: number;
	description?: string;
	thumbnail?: string;
	tags?: string[];
	categories?: string[];
	subtitles?: Record<string, any[]>;
	automatic_captions?: Record<string, any[]>;
}

export class YtubeTranscriptWlang implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'YouTube Transcript With Language V2',
		name: 'ytubeTranscriptWlang',
		icon: 'fa:youtube',
		group: ['transform'],
		version: 1,
		description: 'Fetch YouTube subtitles with language and cookie support using yt-dlp',
		defaults: {
			name: 'YouTube Transcript V2',
		},
		inputs: [NodeConnectionType.Main],
		outputs: [NodeConnectionType.Main],
		properties: [
			{
				displayName: 'Video ID/URL',
				name: 'videoId',
				type: 'string',
				default: '',
				required: true,
				description: 'The YouTube video ID or URL',
				placeholder: 'dQw4w9WgXcQ or https://www.youtube.com/watch?v=dQw4w9WgXcQ',
			},
			{
				displayName: 'Language',
				name: 'lang',
				type: 'string',
				default: 'en',
				description: 'Language code for the transcript (e.g., en, vi, fr, es)',
				placeholder: 'en',
			},
			{
				displayName: 'Prefer Manual Subtitles',
				name: 'preferManual',
				type: 'boolean',
				default: true,
				description: 'Whether to prefer manual subtitles over auto-generated ones',
			},
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{
						name: 'Structured',
						value: 'structured',
						description: 'Returns array of transcript items with timestamps',
					},
					{
						name: 'Plain Text',
						value: 'plainText',
						description: 'Returns concatenated text only',
					},
					{
						name: 'Both',
						value: 'both',
						description: 'Returns both structured and plain text formats',
					},
				],
				default: 'structured',
				description: 'Format of the transcript output',
			},
			{
				displayName: 'Include Metadata',
				name: 'includeMetadata',
				type: 'boolean',
				default: false,
				description: 'Whether to include video metadata (title, duration, uploader, etc.)',
			},
			{
				displayName: 'Binary Path',
				name: 'binaryPath',
				type: 'string',
				default: 'yt-dlp',
				description: 'Path to yt-dlp binary. Use "yt-dlp" if installed globally.',
				placeholder: '/usr/local/bin/yt-dlp',
			},
			{
				displayName: 'Authentication Method',
				name: 'authMethod',
				type: 'options',
				options: [
					{
						name: 'None',
						value: 'none',
						description: 'No authentication (for public videos)',
					},
					{
						name: 'Cookie String',
						value: 'cookieString',
						description: 'Use cookie string for authentication',
					},
					{
						name: 'Cookie File',
						value: 'cookieFile',
						description: 'Use cookie file for authentication',
					},
				],
				default: 'none',
				description: 'Authentication method for restricted videos',
			},
			{
				displayName: 'Cookie String',
				name: 'cookieString',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						authMethod: ['cookieString'],
					},
				},
				description: 'Cookie string for authentication (export from browser)',
				typeOptions: {
					password: true,
				},
			},
			{
				displayName: 'Cookie File Path',
				name: 'cookieFile',
				type: 'string',
				default: '',
				displayOptions: {
					show: {
						authMethod: ['cookieFile'],
					},
				},
				description: 'Absolute path to cookie file for authentication',
				placeholder: '/path/to/cookies.txt',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const nodeInstance = new YtubeTranscriptWlang();

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			let cookieFilePath = '';
			let authMethod = 'none';

			try {
				// Get node parameters
				const videoId = this.getNodeParameter('videoId', itemIndex) as string;
				const lang = (this.getNodeParameter('lang', itemIndex) as string) || 'en';
				const preferManual = this.getNodeParameter('preferManual', itemIndex) as boolean;
				const outputFormat = this.getNodeParameter('outputFormat', itemIndex) as string;
				const includeMetadata = this.getNodeParameter('includeMetadata', itemIndex) as boolean;
				const binaryPath = this.getNodeParameter('binaryPath', itemIndex) as string;
				authMethod = this.getNodeParameter('authMethod', itemIndex) as string;

				// Validate required parameters
				if (!videoId?.trim()) {
					throw new NodeOperationError(this.getNode(), 'The video ID/URL parameter is empty.', {
						itemIndex,
					});
				}

				// Handle cookie authentication
				if (authMethod === 'cookieString') {
					const cookieString = this.getNodeParameter('cookieString', itemIndex) as string;
					if (cookieString?.trim()) {
						cookieFilePath = join(tmpdir(), `yt-cookies-${Date.now()}-${itemIndex}.txt`);
						const cookieContent = '# Netscape HTTP Cookie File\n' + cookieString;
						try {
							await writeFile(cookieFilePath, cookieContent);
						} catch (error) {
							// Ignore writeFile error (likely permission or temp issue)
						}
					}
				} else if (authMethod === 'cookieFile') {
					cookieFilePath = this.getNodeParameter('cookieFile', itemIndex) as string;
				}

				// Normalize video URL
				const videoUrl = nodeInstance.normalizeVideoUrl(videoId);

				// Get video metadata if needed
				let parsedInfo: VideoMetadata | null = null;
				if (includeMetadata) {
					parsedInfo = await nodeInstance.getVideoMetadata(binaryPath, cookieFilePath, videoUrl, this.getNode());
				}

				// Get subtitle information
				const metadataForSubtitles = parsedInfo || await nodeInstance.getVideoMetadata(binaryPath, cookieFilePath, videoUrl, this.getNode());
				const subtitles = metadataForSubtitles.subtitles || {};
				const autoCaptions = metadataForSubtitles.automatic_captions || {};

				// Find best subtitle match
				const { selectedSubtitle, isManualSubtitle } = nodeInstance.findBestSubtitle(
					subtitles,
					autoCaptions,
					lang,
					preferManual
				);

				if (!selectedSubtitle) {
					throw new NodeOperationError(
						this.getNode(),
						`No transcript found for this video with language "${lang}". Available languages: ${nodeInstance.getAvailableLanguages(subtitles, autoCaptions)}`,
						{ itemIndex }
					);
				}

				// Download and parse transcript
				const formattedTranscript = await nodeInstance.downloadAndParseTranscript(
					binaryPath,
					cookieFilePath,
					videoUrl,
					lang,
					itemIndex,
					isManualSubtitle,
					this.getNode()
				);

				// Build result object
				const result: any = {
					youtubeId: nodeInstance.extractVideoId(videoId),
					videoUrl: videoUrl,
					language: lang,
					subtitleType: isManualSubtitle ? 'manual' : 'auto-generated',
					transcriptLength: formattedTranscript.length,
				};

				// Add transcript data based on output format
				if (outputFormat === 'structured' || outputFormat === 'both') {
					result.transcript = formattedTranscript;
				}

				if (outputFormat === 'plainText' || outputFormat === 'both') {
					result.transcriptText = formattedTranscript.map((item: TranscriptItem) => item.text).join(' ');
				}

				// Add metadata if requested
				if (includeMetadata && parsedInfo) {
					result.metadata = nodeInstance.extractMetadata(parsedInfo);
				}

				returnData.push({
					json: result,
					pairedItem: { item: itemIndex },
				});

			} catch (error) {
				// Handle specific error types
				if (error.message.includes('yt-dlp') || error.message.includes('command not found')) {
					throw new NodeOperationError(
						this.getNode(),
						'yt-dlp binary not found or failed to run. Please check the binaryPath parameter.',
						{ itemIndex }
					);
				}

				if (this.continueOnFail()) {
					returnData.push({
						json: {
							error: error.message,
							videoId: this.getNodeParameter('videoId', itemIndex, '') as string,
						},
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				throw error;
			} finally {
				// Cleanup temporary cookie file
				if (cookieFilePath && authMethod === 'cookieString') {
					try {
						await unlink(cookieFilePath);
					} catch (error) {
						// Ignore unlink error
					}
				}
			}
		}

		return this.prepareOutputData(returnData);
	}

	normalizeVideoUrl(videoId: string): string {
		if (videoId.includes('youtube.com') || videoId.includes('youtu.be')) {
			return videoId;
		}
		return `https://www.youtube.com/watch?v=${videoId}`;
	}

	extractVideoId(videoInput: string): string {
		if (videoInput.includes('youtube.com') || videoInput.includes('youtu.be')) {
			const match = videoInput.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
			return match ? match[1] : videoInput;
		}
		return videoInput;
	}

	getAvailableLanguages(subtitles: Record<string, any[]>, autoCaptions: Record<string, any[]>): string {
		const allLangs = [...Object.keys(subtitles), ...Object.keys(autoCaptions)];
		return allLangs.length > 0 ? allLangs.join(', ') : 'none';
	}

	async getVideoMetadata(binaryPath: string, cookieFilePath: string, videoUrl: string, node: any): Promise<VideoMetadata> {
		let cmd = `${binaryPath} --dump-json --skip-download`;
		if (cookieFilePath) {
			cmd += ` --cookies "${cookieFilePath}"`;
		}
		cmd += ` "${videoUrl}"`;

		try {
			const { stdout } = await execAsync(cmd);
			return JSON.parse(stdout) as VideoMetadata;
		} catch (error) {
			throw new NodeOperationError(
				node,
				`Failed to fetch video metadata: ${error.message}`
			);
		}
	}

	findBestSubtitle(
		subtitles: Record<string, any[]>,
		autoCaptions: Record<string, any[]>,
		lang: string,
		preferManual: boolean
	): { selectedSubtitle: any[] | null; isManualSubtitle: boolean } {
		const langVariants = [lang, `${lang}_US`, `${lang}-US`, `${lang}.US`];

		for (const langVar of langVariants) {
			if (preferManual && subtitles[langVar]?.length) {
				return { selectedSubtitle: subtitles[langVar], isManualSubtitle: true };
			} else if (!preferManual && (subtitles[langVar]?.length || autoCaptions[langVar]?.length)) {
				return {
					selectedSubtitle: subtitles[langVar] || autoCaptions[langVar],
					isManualSubtitle: !!subtitles[langVar]
				};
			}
		}

		// Fallback: try any available subtitle
		for (const langVar of langVariants) {
			if (subtitles[langVar]?.length || autoCaptions[langVar]?.length) {
				return {
					selectedSubtitle: subtitles[langVar] || autoCaptions[langVar],
					isManualSubtitle: !!subtitles[langVar]
				};
			}
		}

		return { selectedSubtitle: null, isManualSubtitle: false };
	}

	async downloadAndParseTranscript(
		binaryPath: string,
		cookieFilePath: string,
		videoUrl: string,
		lang: string,
		itemIndex: number,
		isManualSubtitle: boolean,
		node: any
	): Promise<TranscriptItem[]> {
		const outputPath = join(tmpdir(), `transcript-${Date.now()}-${itemIndex}`);
		const flag = isManualSubtitle ? 'write-subs' : 'write-auto-subs';
		let cmd = `${binaryPath} --${flag} --sub-lang ${lang} --skip-download --output "${outputPath}.%(ext)s"`;
		if (cookieFilePath) {
			cmd += ` --cookies "${cookieFilePath}"`;
		}
		cmd += ` "${videoUrl}"`;

		try {
			await execAsync(cmd);
		} catch (error) {
			throw new NodeOperationError(
				node,
				`Failed to download transcript: ${error.message}`
			);
		}

		const possibleFiles = [
			`${outputPath}.${lang}.vtt`, `${outputPath}.${lang}.srt`,
			`${outputPath}.${lang}_US.vtt`, `${outputPath}.${lang}_US.srt`,
			`${outputPath}.${lang}-US.vtt`, `${outputPath}.${lang}-US.srt`,
		];

		let transcriptContent = '';
		let usedFile = '';

		for (const file of possibleFiles) {
			try {
				transcriptContent = await readFile(file, 'utf-8');
				usedFile = file;
				break;
			} catch (error) {
				// File not found, try next
			}
		}

		if (!transcriptContent) {
			throw new NodeOperationError(
				node,
				`Could not read transcript file for language "${lang}"`
			);
		}

		const result = this.parseTranscriptContent(transcriptContent);

		if (usedFile) {
			try {
				await unlink(usedFile);
			} catch (error) {
				// Ignore unlink error
			}
		}

		return result;
	}

	extractMetadata(info: VideoMetadata): Record<string, any> {
		return {
			title: info.title,
			duration: info.duration,
			uploader: info.uploader,
			uploadDate: info.upload_date,
			viewCount: info.view_count,
			description: info.description,
			thumbnail: info.thumbnail,
			tags: info.tags,
			categories: info.categories,
		};
	}

	parseTranscriptContent(content: string): TranscriptItem[] {
		const transcript: TranscriptItem[] = [];
		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (line.includes(' --> ')) {
				const [startTime, endTime] = line.split(' --> ');
				const start = this.timeToSeconds(startTime);
				const end = this.timeToSeconds(endTime);
				const duration = end - start;

				let text = '';
				i++;
				while (i < lines.length && lines[i].trim() && !lines[i].includes(' --> ')) {
					const clean = lines[i].replace(/<[^>]*>/g, '').trim();
					if (clean) text += clean + ' ';
					i++;
				}
				i--;

				if (text.trim()) {
					transcript.push({
						text: text.trim(),
						start: +start.toFixed(3),
						duration: +duration.toFixed(3),
					});
				}
			}
		}

		return transcript;
	}

	timeToSeconds(timeString: string): number {
		const parts = timeString.split(':');
		if (parts.length === 3) {
			const [h, m, s] = parts;
			return (+h) * 3600 + (+m) * 60 + parseFloat(s);
		}

		if (parts.length === 2) {
			const [m, s] = parts;
			return (+m) * 60 + parseFloat(s);
		}

		return parseFloat(timeString);
	}
}
