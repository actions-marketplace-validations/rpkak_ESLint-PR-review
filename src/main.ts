import * as core from '@actions/core'
import {context, getOctokit} from '@actions/github'
import {ESLint} from 'eslint'
import {readFileSync} from 'fs'
import {isAbsolute, join} from 'path'
import {argv} from 'process'

const run = async (): Promise<void> => {
  try {
    let projectRoot = argv[2]
    if (!isAbsolute(projectRoot)) {
      projectRoot = join(process.cwd(), projectRoot)
    }
    const eslint = new ESLint({
      cwd: projectRoot
    })

    const resultArr = await eslint.lintFiles(argv[3])
    if (context.eventName === 'pull_request') {
      const octokit = getOctokit(argv[4])

      const oldReviews = (
        await octokit.pulls.listReviews({
          ...context.repo,
          pull_number: context.payload.pull_request?.number as number
        })
      ).data.filter(
        review =>
          review.user?.id === 41898282 &&
          (review.body.startsWith(
            '[comment]: <> (Generated by ESLint PR review. View: https://github.com/marketplace/actions/eslint-pr-review)\n'
          ) ||
            review.state === 'APPROVE')
      )
      // core.info(JSON.stringify(oldReviews))
      if (oldReviews.length) {
        const oldReview = oldReviews[oldReviews.length - 1]
        core.info(JSON.stringify(oldReview))

        if (oldReview.state === 'REQUEST_CHANGES') {
          await octokit.pulls.updateReview({
            ...context.repo,
            pull_number: context.payload.pull_request?.number as number,
            review_id: oldReview.id,
            body: `${oldReview.body} - :warning: Outdated :warning:`
          })

          const oldCommentIds = (
            await octokit.pulls.listCommentsForReview({
              ...context.repo,
              review_id: oldReview.id,
              pull_number: context.payload.pull_request?.number as number
            })
          ).data.map(comment => comment.id)

          for (const oldCommentId of oldCommentIds) {
            await octokit.pulls.deleteReviewComment({
              ...context.repo,
              comment_id: oldCommentId
            })
          }
        }
      }

      const filesChanged = (
        await octokit.pulls.listFiles({
          ...context.repo,
          pull_number: context.payload.pull_request?.number as number
        })
      ).data.map(file => file.filename)

      const allComments: {
        path: string
        body: string
        start_line?: number
        line: number
      }[] = []
      for (const file of resultArr) {
        for (const message of file.messages) {
          if (message.fix) {
            const normalFileContent = readFileSync(file.filePath).toString()
            const normalLines = normalFileContent.split('\n')
            const fixedFileContent =
              normalFileContent.substr(0, message.fix.range[0]) +
              message.fix.text +
              normalFileContent.substr(message.fix.range[1])
            const fixedLines = fixedFileContent.split('\n')
            let startLine = 0
            while (normalLines[startLine] === fixedLines[startLine]) {
              startLine++
            }
            const difference = normalLines.length - fixedLines.length
            let line = normalLines.length
            while (normalLines[line] === fixedLines[line - difference]) {
              line--
            }

            const newLines = fixedLines.slice(startLine, line - difference + 1)

            startLine++
            line++
            allComments.push({
              path: file.filePath.replace(`${process.cwd()}/`, ''),
              body: `${message.message}\n\`\`\`suggestion\n${newLines.join(
                '\n'
              )}\n\`\`\``,
              start_line: startLine === line ? undefined : startLine,
              line
            })
          } else {
            allComments.push({
              path: file.filePath.replace(`${process.cwd()}/`, ''),
              body: message.message,
              start_line:
                message.line === message.endLine ? undefined : message.line,
              line: message.endLine as number
            })
          }
        }
      }
      const comments = []
      const bodyComments = new Map<
        string,
        {
          path: string
          body: string
          start_line?: number
          line: number
        }[]
      >()

      for (const comment of allComments) {
        if (filesChanged.includes(comment.path)) {
          comments.push(comment)
        } else {
          if (bodyComments.has(comment.path)) {
            bodyComments.get(comment.path)?.push(comment)
          } else {
            bodyComments.set(comment.path, [comment])
          }
        }
      }
      // if (allComments.length) {
      const review = await octokit.pulls.createReview({
        ...context.repo,
        pull_number: context.payload.pull_request?.number as number,
        body: allComments.length
          ? `[comment]: <> (Generated by ESLint PR review. View: https://github.com/marketplace/actions/eslint-pr-review)\n## ${
              allComments.length
            } Problems found${
              bodyComments.size
                ? `\n${[...bodyComments.entries()]
                    .map(
                      ([path, commentArr]) =>
                        `### ${path}\n${commentArr
                          .map(
                            comment =>
                              `${
                                comment.start_line === undefined
                                  ? `Line ${comment.line}:`
                                  : `From line ${comment.start_line} to ${comment.line}:`
                              }\n${comment.body}`
                          )
                          .join('\n---\n')}`
                    )
                    .join('\n')}`
                : ''
            }`
          : undefined,
        comments,
        headers: {
          accept: 'application/vnd.github.v3+json'
        }
      })
      await octokit.pulls.submitReview({
        ...context.repo,
        event: allComments.length ? 'REQUEST_CHANGES' : 'APPROVE',
        pull_number: context.payload.pull_request?.number as number,
        review_id: review.data.id
      })
      // }
      if (allComments.length) {
        const formatter = await eslint.loadFormatter(argv[5])
        const formatted = formatter.format(resultArr)
        core.setFailed(formatted)
      }
    } else {
      if (
        resultArr.reduce(
          (sum, result) => sum + result.errorCount + result.warningCount,
          0
        )
      ) {
        const formatter = await eslint.loadFormatter(argv[5])
        const formatted = formatter.format(resultArr)
        core.setFailed(formatted)
      }
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
