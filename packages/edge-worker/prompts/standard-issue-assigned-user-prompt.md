<context>
  <repository>{{repository_name}}</repository>
  <working_directory>{{working_directory}}</working_directory>
  <base_branch>{{base_branch}}</base_branch>
</context>

<linear_issue>
  <id>{{issue_id}}</id>
  <identifier>{{issue_identifier}}</identifier>
  <title>{{issue_title}}</title>
  <description>
{{issue_description}}
  </description>
  <state>{{issue_state}}</state>
  <priority>{{issue_priority}}</priority>
  <url>{{issue_url}}</url>
  <assignee>
    <linear_display_name>{{assignee_name}}</linear_display_name>
    <linear_profile_url>{{assignee_linear_profile_url}}</linear_profile_url>
    <github_username>{{assignee_github_username}}</github_username>
    <github_user_id>{{assignee_github_user_id}}</github_user_id>
    <github_noreply_email>{{assignee_github_noreply_email}}</github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
{{comment_threads}}
</linear_comments>

<frontend_screenshot_requirement>
If you changed frontend/UI code and the app can reasonably be rendered locally, capture at least one fresh screenshot before your final response.
Save the screenshot under `cyrus-screenshots/` or another workspace path containing `screenshot`, and leave it uncommitted so Cyrus can attach it to the GitHub PR.
If no browser MCP/tool is available, use shell Playwright instead, for example: `mkdir -p cyrus-screenshots && npx -y playwright@latest screenshot --browser chromium <local-url> cyrus-screenshots/frontend-after.png`
If you cannot capture a meaningful screenshot because the app cannot be run, requires unavailable auth/data, or there is no visual surface to render, state that exact reason in your final response.
</frontend_screenshot_requirement>

{{#if new_comment}}
<new_comment_to_address>
  <author>{{new_comment_author}}</author>
  <timestamp>{{new_comment_timestamp}}</timestamp>
  <content>
{{new_comment_content}}
  </content>
</new_comment_to_address>

IMPORTANT: Focus specifically on addressing the new comment above. This is a new request that requires your attention.
{{/if}}
